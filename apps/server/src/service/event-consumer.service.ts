import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { EngineTokenSigner } from './engine-token.signer.js';
import { PrismaService } from '../shared/prisma.service.js';

/**
 * 事件消费(SD4):pull + ack 主通道。
 * - 每 2 分钟(可配)+ accept 后即时触发(由 BFF accept 路由的审计钩子调用,本进程内单例);
 * - 逐 workspace(经 workspace_registry)拉取多页 → eventId 幂等入库 + 派生 → 批量 ACK → 推进游标;
 * - ACK 失败不推进游标,下轮重拉同一页(事件幂等),避免“已入库但永远未 ACK”；
 * - 首次开启即自动回放存量(PRD G4:引擎 279 条 PENDING,含 11 条 LeadQualified)。
 * 引擎合同:GET /api/v1/events?cursor&limit → { data: envelope[], page: { next_cursor, has_more } };
 * envelope 字段 event_type/occurred_at/aggregate_id/payload;POST /api/v1/events/ack { event_ids }。
 */

interface EngineEventEnvelope {
  event_id: string;
  event_type: string;
  workspace_id: string;
  occurred_at: string;
  aggregate_type?: string;
  aggregate_id?: string;
  payload: unknown;
  privacy_classification?: string;
}

interface EngineEventPage {
  data?: EngineEventEnvelope[];
  page?: { next_cursor?: string | null; has_more?: boolean };
}

const MAX_PAGES_PER_TICK = 10;

@Injectable()
export class EventConsumerService implements OnModuleInit {
  private readonly logger = new Logger(EventConsumerService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly signer: EngineTokenSigner,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    if (!this.config.EVENT_CONSUMER_ENABLED) {
      this.logger.log('事件消费未开启(EVENT_CONSUMER_ENABLED=false)。开启前置:引擎 AUTH_ROLE_SCOPE_MAP_JSON 增加 saas-event-consumer(deploy/engine-integration.md)。');
    }
  }

  private async mintConsumerToken(workspaceId: string): Promise<string> {
    return this.signer.mint({ subjectId: 'saas-event-consumer', workspaceId, roles: ['saas-event-consumer'] });
  }

  /** 消费一轮。返回统计;任何 workspace 失败只记日志,不阻断其余 workspace。 */
  async consumeOnce(): Promise<{ workspaces: number; pulled: number; acked: number; skipped?: string }> {
    if (!this.config.EVENT_CONSUMER_ENABLED) {
      return { workspaces: 0, pulled: 0, acked: 0, skipped: 'EVENT_CONSUMER_ENABLED=false' };
    }
    const registry = await this.prisma.workspaceRegistry.findMany({ where: { enabled: true } });
    let pulled = 0;
    let acked = 0;
    for (const ws of registry) {
      try {
        const result = await this.consumeWorkspace(ws.workspaceId, ws.cursor);
        pulled += result.pulled;
        acked += result.acked;
      } catch (err) {
        this.logger.warn(`workspace ${ws.workspaceId} 消费失败(下轮重试): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { workspaces: registry.length, pulled, acked };
  }

  private async consumeWorkspace(workspaceId: string, cursor: string | null): Promise<{ pulled: number; acked: number }> {
    let pulled = 0;
    let acked = 0;
    let currentCursor = cursor;

    for (let pageNo = 0; pageNo < MAX_PAGES_PER_TICK; pageNo += 1) {
      const token = await this.mintConsumerToken(workspaceId);
      const query: Record<string, string> = { limit: String(this.config.EVENT_CONSUMER_PAGE_LIMIT) };
      if (currentCursor) query.cursor = currentCursor;
      const res = await fetch(this.eventsUrl(query), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error(`引擎拒绝事件拉取(HTTP ${res.status})—— 检查引擎角色映射与 issuer/audience 配置(deploy/engine-integration.md)`);
      }
      if (!res.ok) throw new Error(`事件拉取 HTTP ${res.status}`);
      const page = (await res.json()) as EngineEventPage;
      const events = page.data ?? [];

      if (events.length === 0) {
        await this.touchRegistry(workspaceId, currentCursor);
        break;
      }

      const seenIds = events.map((evt) => evt.event_id);
      for (const evt of events) {
        const known = await this.prisma.eventInbox.findUnique({ where: { eventId: evt.event_id } });
        if (known) continue; // 幂等:已知事件跳过派生,但仍参与 ACK
        await this.prisma.$transaction(async (tx) => {
          await tx.eventInbox.create({
            data: {
              eventId: evt.event_id,
              workspaceId,
              type: evt.event_type,
              payload: (evt.payload ?? {}) as Prisma.InputJsonValue,
              occurredAt: new Date(evt.occurred_at),
            },
          });
          await this.derive(tx, workspaceId, evt);
        });
        pulled += 1;
      }

      let ackedCount = 0;
      let ackOk = false;
      if (seenIds.length > 0) {
        const ackRes = await fetch(this.engineUrl('/events/ack'), {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ event_ids: seenIds }),
          signal: AbortSignal.timeout(30_000),
        });
        if (ackRes.ok) {
          const body = (await ackRes.json().catch(() => ({}))) as { data?: { acked?: number } };
          ackedCount = body.data?.acked ?? seenIds.length;
          ackOk = true;
          await this.prisma.eventInbox.updateMany({
            where: { eventId: { in: seenIds } },
            data: { ackedAt: new Date() },
          });
        } else {
          this.logger.warn(`workspace ${workspaceId} ACK 失败(HTTP ${ackRes.status}),保留游标下轮重拉/补 ACK`);
        }
      }
      acked += ackedCount;

      // ACK 失败时不能越过本页；否则这些事件永远停在 PENDING。
      if (!ackOk) {
        await this.touchRegistry(workspaceId, currentCursor);
        break;
      }

      const nextCursor = page.page?.next_cursor ?? null;
      if (page.page?.has_more === true && nextCursor) {
        currentCursor = nextCursor;
        await this.touchRegistry(workspaceId, currentCursor);
        continue;
      }
      // 没有更多：保留当前游标；新事件交付行 id 更大，下轮仍可看见，末页会幂等重放一次。
      await this.touchRegistry(workspaceId, currentCursor);
      break;
    }

    return { pulled, acked };
  }

  private async touchRegistry(workspaceId: string, cursor: string | null): Promise<void> {
    await this.prisma.workspaceRegistry.update({
      where: { workspaceId },
      data: { cursor, lastPulledAt: new Date() },
    });
  }

  /** 派生:LeadQualified→qualified_lead;终态/关键事件→notification;成本→cost_ledger(SD3)。 */
  private async derive(tx: Prisma.TransactionClient, workspaceId: string, evt: EngineEventEnvelope): Promise<void> {
    const type = evt.event_type;
    const payload = (evt.payload ?? {}) as Record<string, unknown>;
    const aggregateId = typeof evt.aggregate_id === 'string' ? evt.aggregate_id : '';

    if (type === 'LeadQualified') {
      const leadId =
        (typeof payload.lead_id === 'string' && payload.lead_id) ||
        (typeof payload.leadId === 'string' && payload.leadId) ||
        aggregateId;
      await tx.qualifiedLead.create({
        data: {
          eventId: evt.event_id,
          workspaceId,
          leadId,
          icpId: typeof payload.icp_id === 'string' ? payload.icp_id : null,
          snapshot: payload as Prisma.InputJsonValue,
        },
      });
      await this.notify(tx, workspaceId, type, leadId, '有一条新的「值得跟进」买家线索，待你查看');
      return;
    }

    if (type === 'DiscoveryRunCompleted') {
      const runId =
        (typeof payload.run_id === 'string' && payload.run_id) ||
        (typeof payload.runId === 'string' && payload.runId) ||
        aggregateId;
      const status = typeof payload.status === 'string' ? payload.status : '';
      const notificationType =
        status === 'PARTIAL'
          ? 'DiscoveryRunPartial'
          : status === 'FAILED'
            ? 'DiscoveryRunFailed'
            : 'DiscoveryRunCompleted';
      const title =
        status === 'PARTIAL'
          ? '寻源任务部分完成，已产出的线索可以先去判断'
          : status === 'FAILED'
            ? '寻源任务未完成，查看原因后调整目标买家'
            : '寻源任务已完成，线索已就绪';
      await this.notify(tx, workspaceId, notificationType, runId, title);
      return;
    }

    // 单条事实审批不生成站内通知：一次理解会产生上百条 Claim，逐条通知会把铃铛淹没。
    // 审批结果仍在企业事实页与审计中可见。
    const cost = payload.cost ?? payload.cost_usd;
    if (typeof cost === 'number' && cost > 0) {
      await tx.costLedger.create({
        data: { workspaceId, sourceEventId: evt.event_id, amountMicros: Math.round(cost * 1_000_000), occurredAt: new Date() },
      });
    }
  }

  private async notify(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    type: string,
    refId: string,
    title: string,
  ): Promise<void> {
    await tx.notification.create({ data: { workspaceId, type, refId: refId || null, title } });
  }

  private eventsUrl(query: Record<string, string>): string {
    const url = new URL('/api/v1/events', this.config.ENGINE_ORIGIN);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url.toString();
  }

  private engineUrl(path: string): string {
    return new URL(`/api/v1${path}`, this.config.ENGINE_ORIGIN).toString();
  }
}

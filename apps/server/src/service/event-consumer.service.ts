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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    const registry = await this.prisma.workspaceRegistry.findMany({
      where: { enabled: true, workspace: { status: 'ACTIVE' } },
    });
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
      try {
        await this.evaluateQuotaAlerts(ws.workspaceId);
      } catch (err) {
        this.logger.warn(`workspace ${ws.workspaceId} 配额告警评估失败(不影响事件消费): ${err instanceof Error ? err.message : String(err)}`);
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

  /**
   * P5 配额告警：与签发闸门同口径（workspace_budget_policy + cost_ledger + discovery_run_link）。
   * 每窗口每档一条（≥80% 预警、≥100% 耗尽）；豁免空间（policy.enabled=false）与
   * WORKSPACE_QUOTA_ENFORCE=false 不发——未被强制的额度不做惊吓式提醒。
   */
  private async evaluateQuotaAlerts(workspaceId: string): Promise<void> {
    if (!this.config.WORKSPACE_QUOTA_ENFORCE) return;
    const policy = await this.prisma.workspaceBudgetPolicy.findUnique({ where: { workspaceId } });
    if (!policy || !policy.enabled) return;
    const since = new Date(Date.now() - policy.windowDays * 86_400_000);
    const [spend, usedRuns] = await Promise.all([
      this.prisma.costLedger.aggregate({
        _sum: { amountMicros: true },
        where: { workspaceId, occurredAt: { gte: since } },
      }),
      this.prisma.discoveryRunLink.count({
        where: { workspaceId, createdAt: { gte: since } },
      }),
    ]);
    const usedSpendMicros = BigInt(spend._sum.amountMicros ?? 0);
    const maxSpendMicros = BigInt(policy.maxSpendMicros);
    const spendRatio =
      maxSpendMicros === 0n ? 1 : Number(usedSpendMicros) / Number(maxSpendMicros);
    const runsRatio = policy.maxRuns <= 0 ? 1 : usedRuns / policy.maxRuns;
    const ratio = Math.max(spendRatio, runsRatio);
    const type =
      ratio >= 1 ? 'WorkspaceQuotaExceeded' : ratio >= 0.8 ? 'WorkspaceQuotaWarning' : null;
    if (!type) return;
    const existing = await this.prisma.notification.findFirst({
      where: { workspaceId, type, createdAt: { gte: since } },
      select: { id: true },
    });
    if (existing) return;
    const detail =
      `花费 $${(Number(usedSpendMicros) / 1_000_000).toFixed(2)} / $${(Number(maxSpendMicros) / 1_000_000).toFixed(2)}，` +
      `运行 ${usedRuns}/${policy.maxRuns} 次`;
    const title =
      type === 'WorkspaceQuotaExceeded'
        ? `本期额度已用完（${detail}），新的寻源任务将被暂停`
        : `额度提醒：已使用本期额度的 ${Math.min(999, Math.round(ratio * 100))}%（${detail}），接近上限`;
    await this.prisma.notification.create({
      data: { workspaceId, type, refId: null, title },
    });
  }

  /** 派生:LeadQualified→qualified_lead;终态/关键事件→notification;成本→cost_ledger(SD3)。 */
  private async derive(tx: Prisma.TransactionClient, workspaceId: string, evt: EngineEventEnvelope): Promise<void> {
    const type = evt.event_type;
    const payload = (evt.payload ?? {}) as Record<string, unknown>;
    const aggregateId = typeof evt.aggregate_id === 'string' ? evt.aggregate_id : '';

    // 成本落账必须先于事件类型分支：DiscoveryRunCompleted 等分支处理完即 return,
    // 放在末尾会让携带 cost 的终态事件永远走不到（1b 花费维度补口）。
    // createMany + (workspace_id, source_event_id) 唯一索引吸收 at-least-once 重放。
    const cost = payload.cost ?? payload.cost_usd;
    if (typeof cost === 'number' && cost > 0 && Number.isFinite(cost)) {
      // amount_micros 是 int4：越界会让整个事件事务抛错、游标不前进、单条毒事件
      // 永久卡死该 workspace 的事件流。钳到 int4 上限并记 warn（正常量级 $15/30 天
      // 窗口远达不到这里，触发即上游成本异常）。
      const INT4_MAX = 2_147_483_647;
      const micros = Math.round(cost * 1_000_000);
      if (micros > INT4_MAX) {
        this.logger.warn(
          `event ${evt.event_id} cost ${cost} exceeds int4 micro-USD range; clamped to ${INT4_MAX} (workspace ${workspaceId})`,
        );
      }
      const amountMicros = Math.min(micros, INT4_MAX);
      // 配额窗口按事件发生时间（信封 occurred_at）归属，与 event_inbox 同源；
      // 积压补消费的旧事件不会挤进当前 30 天窗口。
      const eventTime = new Date(evt.occurred_at);
      const occurredAt = Number.isNaN(eventTime.getTime()) ? new Date() : eventTime;
      await tx.costLedger.createMany({
        data: [{ workspaceId, sourceEventId: evt.event_id, amountMicros, occurredAt }],
        skipDuplicates: true,
      });
    }

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
      await this.notify(
        tx,
        workspaceId,
        type,
        leadId,
        '有一条新的「值得跟进」买家线索，待你查看',
        "A new 'worth following up' buyer lead is waiting for your review",
      );
      return;
    }

    if (type === 'LeadsScored') {
      // P5：制裁命中进隔离队列 → 站内提醒（管理员复核）。载荷只有计数，无个人数据。
      const queues = payload.queues;
      const hold =
        queues && typeof queues === 'object' && !Array.isArray(queues)
          ? (queues as Record<string, unknown>).sanctions_hold
          : undefined;
      if (typeof hold === 'number' && hold > 0) {
        const icpId =
          aggregateId ||
          (typeof payload.icp_id === 'string' ? payload.icp_id : '');
        await this.notify(
          tx,
          workspaceId,
          'SanctionsHoldDetected',
          icpId,
          `有 ${hold} 家线索命中制裁名单，已进入隔离队列，需管理员复核`,
          `${hold} lead(s) hit the sanctions list and are quarantined for admin review`,
        );
      }
      return;
    }

    if (type === 'DiscoveryRunCompleted') {
      const runId =
        (typeof payload.run_id === 'string' && payload.run_id) ||
        (typeof payload.runId === 'string' && payload.runId) ||
        aggregateId;
      const status = typeof payload.status === 'string' ? payload.status : '';
      // Run 2.0（M0②）：任务执行记录镜像引擎 run 的终态（stats 仍以引擎为准）。
      const terminalStatus = ['DONE', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(status)
        ? status
        : 'DONE';
      await tx.taskRun.updateMany({
        where: { workspaceId, engineRunId: runId, status: 'RUNNING' },
        data: { status: terminalStatus, finishedAt: new Date() },
      });
      // P1：BFF 在引擎 202 后丢响应的窗口里 TaskRun.engineRunId 为 NULL——用事件 payload 的
      // taskRef（引擎 B1 起随 DiscoveryRunCompleted 携带）按 id 回填并镜像终态。
      const taskRef = payload.taskRef as { taskRunId?: unknown } | undefined;
      const taskRunId =
        taskRef && typeof taskRef.taskRunId === 'string' && UUID.test(taskRef.taskRunId)
          ? taskRef.taskRunId
          : undefined;
      if (taskRunId) {
        await tx.taskRun.updateMany({
          where: { workspaceId, id: taskRunId, engineRunId: null },
          data: { engineRunId: runId, status: terminalStatus, finishedAt: new Date() },
        });
      }
      const notificationType =
        status === 'PARTIAL'
          ? 'DiscoveryRunPartial'
          : status === 'FAILED'
            ? 'DiscoveryRunFailed'
            : status === 'CANCELLED'
              ? 'DiscoveryRunCancelled'
              : 'DiscoveryRunCompleted';
      const title =
        status === 'PARTIAL'
          ? '寻源任务部分完成，已产出的线索可以先去判断'
          : status === 'FAILED'
            ? '寻源任务未完成，查看原因后调整目标买家'
            : status === 'CANCELLED'
              ? '寻源任务已停止，已完成部分的线索保留'
              : '寻源任务已完成，线索已就绪';
      const titleEn =
        status === 'PARTIAL'
          ? 'The discovery task partially finished — judge the leads produced so far'
          : status === 'FAILED'
            ? 'The discovery task did not finish — check the reason and adjust the target customer profiles'
            : status === 'CANCELLED'
              ? 'The discovery task was stopped — leads from the finished part are kept'
              : 'The discovery task finished — leads are ready';
      await this.notify(tx, workspaceId, notificationType, runId, title, titleEn);
      return;
    }

    if (type === 'CandidateBatchCompleted') {
      // M2 步 10：候选批次日志在此只吸收（event_inbox 已存完整 payload）；批次产出/判定分布的
      // 运营归因聚合读 event_inbox，不再落业务表。旧 run 回放（最小/缺字段载荷）必须不报错。
      return;
    }

    // 单条事实审批不生成站内通知：一次理解会产生上百条 Claim，逐条通知会把铃铛淹没。
    // 审批结果仍在企业事实页与审计中可见。
  }

  private async notify(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    type: string,
    refId: string,
    title: string,
    titleEn: string,
  ): Promise<void> {
    await tx.notification.create({
      data: { workspaceId, type, refId: refId || null, title, titleEn },
    });
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

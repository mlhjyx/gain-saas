import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Prisma, type EventInbox } from '@prisma/client';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { EngineTokenSigner } from './engine-token.signer.js';
import { PrismaService } from '../shared/prisma.service.js';

/**
 * 事件消费(SD4):pull + ack 主通道。
 * - Worker 每轮先恢复到期派生，再拉取新事件;
 * - 逐 workspace 拉取多页 → 持久入箱 → 独立事务派生 → 批量 ACK → 推进游标;
 * - ACK 失败不推进游标,下轮重拉同一页(事件幂等),避免“已入库但永远未 ACK”；
 * - 首次开启即自动回放存量(PRD G4:引擎 279 条 PENDING,含 11 条 LeadQualified)。
 * 引擎合同:GET /api/v1/events?cursor&limit → { data: envelope[], page: { next_cursor, has_more } };
 * envelope 字段 event_type/occurred_at/aggregate_id/payload;POST /api/v1/events/ack { event_ids }。
 */

interface EngineEventPage {
  data: unknown[];
  page?: { next_cursor?: string | null; has_more?: boolean };
}

type ProjectionEvent = Pick<
  EventInbox,
  'eventId' | 'workspaceId' | 'type' | 'payload' | 'occurredAt' | 'aggregateId' | 'projectionAttempts'
>;

const MAX_PAGES_PER_TICK = 10;
const MAX_PROJECTION_ATTEMPTS = 5;
const RETRY_DELAY_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_STATUSES = new Set(['DONE', 'PARTIAL', 'FAILED', 'CANCELLED']);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function discoveryRunId(payload: Record<string, unknown>, aggregateId: string | null): string {
  return text(payload.run_id) || text(payload.runId) || aggregateId || '';
}

function inboxEvent(input: unknown, workspaceId: string) {
  if (!isObject(input) || !EVENT_ID.test(text(input.event_id)) ||
      text(input.workspace_id).toLowerCase() !== workspaceId.toLowerCase()) {
    return null;
  }

  const now = new Date();
  const occurredAt = new Date(text(input.occurred_at));
  const type = text(input.event_type);
  const aggregateId = text(input.aggregate_id) || null;
  // Unversioned envelopes use the original format. Explicit newer versions must be supported.
  const version = input.schema_version === undefined ? 1 : input.schema_version;
  const schemaVersion = typeof version === 'number' && Number.isInteger(version) && version > 0 && version <= 2_147_483_647
    ? version
    : null;

  let projectionError: string | null = null;
  if (!type) {
    projectionError = 'INVALID_EVENT_TYPE';
  } else if (!Number.isFinite(occurredAt.getTime())) {
    projectionError = 'INVALID_OCCURRED_AT';
  } else if (schemaVersion !== 1 && !(type === 'LeadQualified' && schemaVersion === 2)) {
    projectionError = 'UNSUPPORTED_SCHEMA_VERSION';
  } else if (!isObject(input.payload)) {
    projectionError = 'INVALID_PAYLOAD';
  } else if (type === 'DiscoveryRunCompleted' &&
      (!TERMINAL_STATUSES.has(text(input.payload.status)) || !UUID.test(discoveryRunId(input.payload, aggregateId)))) {
    projectionError = 'INVALID_DISCOVERY_COMPLETION';
  } else if (type === 'LeadQualified' && !(text(input.payload.lead_id) || text(input.payload.leadId) || aggregateId)) {
    projectionError = 'INVALID_QUALIFIED_LEAD';
  }

  return {
    eventId: text(input.event_id).toLowerCase(),
    workspaceId,
    type,
    payload: (input.payload ?? {}) as Exclude<Prisma.JsonValue, null>,
    occurredAt: Number.isFinite(occurredAt.getTime()) ? occurredAt : now,
    aggregateId,
    schemaVersion,
    projectionStatus: projectionError ? 'QUARANTINED' as const : 'PENDING' as const,
    projectionAttempts: 0,
    projectionNextAttemptAt: projectionError ? null : now,
    projectionError,
  };
}

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
        await this.retryPendingProjections(ws.workspaceId);
        const result = await this.consumeWorkspace(ws.workspaceId, ws.cursor);
        pulled += result.pulled;
        acked += result.acked;
      } catch (err) {
        this.logger.warn(`workspace ${ws.workspaceId} 消费失败(下轮重试): ${err instanceof Error ? err.name : 'UNKNOWN_ERROR'}`);
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
      if (!Array.isArray(page.data)) throw new Error('INVALID_EVENT_PAGE');
      if (page.data.length === 0) {
        await this.touchRegistry(workspaceId, currentCursor);
        break;
      }

      const seenIds = new Set<string>();
      for (const input of page.data) {
        const event = inboxEvent(input, workspaceId);
        if (!event) {
          this.logger.warn(`workspace ${workspaceId} 事件 ID 无效或工作空间不符，已跳过且未 ACK`);
          continue;
        }
        if (seenIds.has(event.eventId)) continue;

        const inserted = await this.prisma.eventInbox.createMany({ data: event, skipDuplicates: true });
        if (inserted.count === 0) {
          const known = await this.prisma.eventInbox.findUnique({
            where: { eventId: event.eventId },
            select: { workspaceId: true },
          });
          if (known?.workspaceId !== workspaceId) {
            this.logger.warn(`workspace ${workspaceId} event ${event.eventId} 收件箱归属无法确认，未 ACK`);
            continue;
          }
        } else {
          pulled += 1;
          if (event.projectionStatus === 'PENDING') {
            await this.projectEvent(event);
          } else {
            this.logger.warn(`workspace ${workspaceId} event ${event.eventId} 已隔离 (${event.projectionError})`);
          }
        }
        seenIds.add(event.eventId);
      }

      const ackIds = [...seenIds];
      if (ackIds.length > 0) {
        const ackRes = await fetch(this.engineUrl('/events/ack'), {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ event_ids: ackIds }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!ackRes.ok) {
          this.logger.warn(`workspace ${workspaceId} ACK 失败(HTTP ${ackRes.status}),保留游标下轮重拉/补 ACK`);
          await this.touchRegistry(workspaceId, currentCursor);
          break;
        }
        const body = (await ackRes.json().catch(() => ({}))) as { data?: { acked?: number } };
        acked += body.data?.acked ?? ackIds.length;
        await this.prisma.eventInbox.updateMany({
          where: { workspaceId, eventId: { in: ackIds }, ackedAt: null },
          data: { ackedAt: new Date() },
        });
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

  private async retryPendingProjections(workspaceId: string): Promise<void> {
    const pending = await this.prisma.eventInbox.findMany({
      where: { workspaceId, projectionStatus: 'PENDING', projectionNextAttemptAt: { lte: new Date() } },
      orderBy: [{ projectionNextAttemptAt: 'asc' }, { eventId: 'asc' }],
      take: this.config.EVENT_CONSUMER_PAGE_LIMIT,
      select: {
        eventId: true,
        workspaceId: true,
        type: true,
        payload: true,
        occurredAt: true,
        aggregateId: true,
        projectionAttempts: true,
      },
    });
    for (const event of pending) await this.projectEvent(event);
  }

  private async projectEvent(event: ProjectionEvent): Promise<void> {
    const where = {
      eventId: event.eventId,
      workspaceId: event.workspaceId,
      projectionStatus: 'PENDING' as const,
      projectionAttempts: event.projectionAttempts,
    };
    try {
      await this.prisma.$transaction(async (tx) => {
        // The conditional update locks the pending row. This state and every effect commit together.
        const claimed = await tx.eventInbox.updateMany({
          where,
          data: { projectionStatus: 'APPLIED', projectionNextAttemptAt: null, projectionError: null },
        });
        if (claimed.count === 0) return;
        await this.derive(tx, event);
      });
    } catch {
      const attempts = event.projectionAttempts + 1;
      const exhausted = attempts >= MAX_PROJECTION_ATTEMPTS;
      const failure = await this.prisma.eventInbox.updateMany({
        where,
        data: {
          projectionStatus: exhausted ? 'QUARANTINED' : 'PENDING',
          projectionAttempts: attempts,
          projectionNextAttemptAt: exhausted ? null : new Date(Date.now() + RETRY_DELAY_MS * 2 ** (attempts - 1)),
          projectionError: 'PROJECTION_FAILED',
        },
      });
      if (failure.count > 0) {
        this.logger.warn(
          `workspace ${event.workspaceId} event ${event.eventId} 派生失败，${exhausted ? '已隔离' : '等待重试'} (attempt=${attempts})`,
        );
      }
    }
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
  private async derive(tx: Prisma.TransactionClient, event: ProjectionEvent): Promise<void> {
    const { type, workspaceId } = event;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const aggregateId = event.aggregateId ?? '';

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
          `event ${event.eventId} cost exceeds int4 micro-USD range; clamped to ${INT4_MAX} (workspace ${workspaceId})`,
        );
      }
      const amountMicros = Math.min(micros, INT4_MAX);
      // 配额窗口按事件发生时间（信封 occurred_at）归属，与 event_inbox 同源；
      // 积压补消费的旧事件不会挤进当前 30 天窗口。
      await tx.costLedger.createMany({
        data: [{ workspaceId, sourceEventId: event.eventId, amountMicros, occurredAt: event.occurredAt }],
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
          eventId: event.eventId,
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
      const runId = discoveryRunId(payload, event.aggregateId);
      const status = text(payload.status);
      if (!UUID.test(runId) || !TERMINAL_STATUSES.has(status)) {
        throw new Error('INVALID_DISCOVERY_COMPLETION');
      }
      await tx.taskRun.updateMany({
        where: { workspaceId, engineRunId: runId, status: 'RUNNING' },
        data: { status, finishedAt: new Date() },
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
          data: { engineRunId: runId, status, finishedAt: new Date() },
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

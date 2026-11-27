import { forwardRef, Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { Prisma, type EventInbox } from '@prisma/client';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { EngineTokenSigner } from './engine-token.signer.js';
import { PrismaService } from '../shared/prisma.service.js';
import { legacyWorkspaceQuotaAlertsEnabled } from '../shared/legacy-workspace-quota-alerts.js';
import { DISCOVERY_TASK_RUN_WALLET_REF, extractDiscoveryBillableUnits } from '../wallet/bff-wallet-billing.js';
import { WalletService } from '../wallet/wallet.service.js';

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
// 接受标准 UUID（含 v4/v7），避免引擎升级 UUIDv7 event_id 时被误判为毒丸跳过。
const EVENT_ID = UUID;
const TERMINAL_STATUSES = new Set(['DONE', 'PARTIAL', 'FAILED', 'CANCELLED']);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function jsonContainsUuidRef(value: unknown, refs: ReadonlySet<string>, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false;
  if (typeof value === 'string') {
    return refs.has(value.toLowerCase());
  }
  if (Array.isArray(value)) {
    return value.some((item) => jsonContainsUuidRef(item, refs, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((entry) =>
      jsonContainsUuidRef(entry, refs, depth + 1),
    );
  }
  return false;
}

function scrubAuditPackage(
  pkg: unknown,
  contactRefs: ReadonlySet<string>,
  matchedRefs: ReadonlySet<string>,
  deletionRequestId: string,
): { changed: boolean; value: unknown } {
  if (!isObject(pkg)) {
    return { changed: false, value: pkg };
  }
  let changed = false;
  let nextPkg: Record<string, unknown> = pkg;

  if (Array.isArray(pkg.drafts)) {
    const drafts = pkg.drafts.map((entry) => {
      if (!isObject(entry)) return entry;
      const ref = typeof entry.contactRef === 'string' ? entry.contactRef.toLowerCase() : '';
      const draftId = typeof entry.draftId === 'string' ? entry.draftId.toLowerCase() : '';
      const matched = (ref && contactRefs.has(ref)) || (draftId && matchedRefs.has(draftId));
      if (!matched) return entry;
      changed = true;
      const sends = Array.isArray(entry.sends)
        ? entry.sends.map((send) => {
            if (!isObject(send) || typeof send.error !== 'string') return send;
            return { ...send, error: '[ERASED]' };
          })
        : entry.sends;
      return {
        ...entry,
        recipientEmail: '[ERASED]',
        companyName: '[ERASED]',
        subject: '[ERASED]',
        body: '[ERASED]',
        ...(entry.sends !== undefined ? { sends } : {}),
      };
    });
    if (changed) {
      nextPkg = { ...nextPkg, drafts };
    }
  }

  if (Array.isArray(pkg.events)) {
    let eventsChanged = false;
    const events = pkg.events.map((entry) => {
      if (!isObject(entry)) return entry;
      if (!jsonContainsUuidRef(entry, matchedRefs)) return entry;
      eventsChanged = true;
      return {
        ...entry,
        detail: {
          redacted: true,
          reason: 'GDPR_ART17',
          deletionRequestId,
        },
      };
    });
    if (eventsChanged) {
      changed = true;
      nextPkg = { ...nextPkg, events };
    }
  }

  return changed ? { changed: true, value: nextPkg } : { changed: false, value: pkg };
}

function scrubQualifiedLeadContacts(
  snapshot: unknown,
  contactRefs: ReadonlySet<string>,
): { changed: boolean; value: unknown } {
  if (!isObject(snapshot)) return { changed: false, value: snapshot };
  let changed = false;
  const next: Record<string, unknown> = { ...snapshot };
  for (const key of ['contact_refs', 'contacts'] as const) {
    const list = next[key];
    if (!Array.isArray(list)) continue;
    const filtered = list.filter((item) => !jsonContainsUuidRef(item, contactRefs));
    if (filtered.length !== list.length) {
      changed = true;
      next[key] = filtered;
    }
  }
  return changed ? { changed: true, value: next } : { changed: false, value: snapshot };
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
    @Optional() @Inject(forwardRef(() => WalletService)) private readonly wallet?: WalletService,
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
    const registry = await this.prisma.$queryRaw<Array<{ workspace_id: string; cursor: string | null }>>`
      SELECT workspace_id, cursor FROM public.app_list_enabled_workspaces()
    `;
    let pulled = 0;
    let acked = 0;
    for (let index = 0; index < registry.length; index += 1) {
      const row = registry[index]!;
      const workspaceId = row.workspace_id;
      try {
        await this.retryPendingProjections(workspaceId);
        const result = await this.consumeWorkspace(workspaceId, row.cursor);
        pulled += result.pulled;
        acked += result.acked;
      } catch (err) {
        if (err instanceof TypeError) {
          const remaining = registry.length - index;
          this.logger.warn(`引擎事件端点暂不可达(${err.name})，本轮跳过剩余 ${remaining} 个工作空间，下轮重试`);
          break;
        }
        this.logger.warn(`workspace ${workspaceId} 消费失败(下轮重试): ${err instanceof Error ? err.name : 'UNKNOWN_ERROR'}`);
      }
      try {
        await this.evaluateQuotaAlerts(workspaceId);
      } catch (err) {
        this.logger.warn(`workspace ${workspaceId} 配额告警评估失败(不影响事件消费): ${err instanceof Error ? err.message : String(err)}`);
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

        const inboxOutcome = await this.prisma.withWorkspace(workspaceId, async (tx) => {
          const inserted = await tx.eventInbox.createMany({ data: event, skipDuplicates: true });
          if (inserted.count === 0) {
            const known = await tx.eventInbox.findUnique({
              where: { eventId: event.eventId },
              select: { workspaceId: true },
            });
            return known?.workspaceId === workspaceId ? ('duplicate' as const) : ('foreign' as const);
          }
          return 'inserted' as const;
        });
        if (inboxOutcome === 'foreign') {
          this.logger.warn(`workspace ${workspaceId} event ${event.eventId} 收件箱归属无法确认，未 ACK`);
          continue;
        }
        if (inboxOutcome === 'inserted') {
          pulled += 1;
          if (event.projectionStatus === 'PENDING') {
            await this.projectEvent(event);
          } else {
            this.logger.warn(
              `workspace ${workspaceId} event ${event.eventId} 已落收件箱隔离 (${event.projectionError})，推进游标避免阻断队列`,
            );
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
        await this.prisma.withWorkspace(workspaceId, (tx) =>
          tx.eventInbox.updateMany({
            where: { workspaceId, eventId: { in: ackIds }, ackedAt: null },
            data: { ackedAt: new Date() },
          }),
        );
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
    const pending = await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.eventInbox.findMany({
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
      }),
    );
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
      await this.prisma.withWorkspace(event.workspaceId, async (tx) => {
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
      const failure = await this.prisma.withWorkspace(event.workspaceId, (tx) =>
        tx.eventInbox.updateMany({
          where,
          data: {
            projectionStatus: exhausted ? 'QUARANTINED' : 'PENDING',
            projectionAttempts: attempts,
            projectionNextAttemptAt: exhausted ? null : new Date(Date.now() + RETRY_DELAY_MS * 2 ** (attempts - 1)),
            projectionError: 'PROJECTION_FAILED',
          },
        }),
      );
      if (failure.count > 0) {
        this.logger.warn(
          `workspace ${event.workspaceId} event ${event.eventId} 派生失败，${exhausted ? '已隔离' : '等待重试'} (attempt=${attempts})`,
        );
      }
    }
  }

  private async touchRegistry(workspaceId: string, cursor: string | null): Promise<void> {
    await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.workspaceRegistry.update({
        where: { workspaceId },
        data: { cursor, lastPulledAt: new Date() },
      }),
    );
  }

  /**
   * P5 配额告警：与签发闸门同口径（workspace_budget_policy + cost_ledger + discovery_run_link）。
   * 每窗口每档一条（≥80% 预警、≥100% 耗尽）；豁免空间（policy.enabled=false）与
   * 旧预算旁路或关闭强制配额时停发旧提醒。
   */
  private async evaluateQuotaAlerts(workspaceId: string): Promise<void> {
    if (!legacyWorkspaceQuotaAlertsEnabled(this.config)) return;
    await this.prisma.withWorkspace(workspaceId, async (tx) => {
      const policy = await tx.workspaceBudgetPolicy.findUnique({ where: { workspaceId } });
      if (!policy || !policy.enabled) return;
      const since = new Date(Date.now() - policy.windowDays * 86_400_000);
      const [spend, usedRuns] = await Promise.all([
        tx.costLedger.aggregate({
          _sum: { amountMicros: true },
          where: { workspaceId, occurredAt: { gte: since } },
        }),
        tx.discoveryRunLink.count({
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
      const existing = await tx.notification.findFirst({
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
      await tx.notification.create({
        data: { workspaceId, type, refId: null, title },
      });
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
      const taskRef = payload.taskRef as { taskRunId?: unknown } | undefined;
      const taskRunId =
        taskRef && typeof taskRef.taskRunId === 'string' && UUID.test(taskRef.taskRunId)
          ? taskRef.taskRunId
          : undefined;
      // Match both an existing link and an unlinked taskRef in one UPDATE so a concurrent
      // start response linking the attempt cannot move it between two separate writes.
      await tx.taskRun.updateMany({
        where: {
          workspaceId,
          OR: [
            { engineRunId: runId, status: 'RUNNING' },
            ...(taskRunId ? [{ id: taskRunId, engineRunId: null }] : []),
          ],
        },
        data: { engineRunId: runId, status, finishedAt: new Date() },
      });
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
      // M9 充值钱包异步结算：仅在 WALLET_BILLING_ENABLED 开启且存在活跃预占单时按合格线索数结算；
      // FAILED / CANCELLED / 0 线索自动 0 扣费全额退点（兼容真实引擎 stats.quickScan.leads / stats.fit.match）。
      if (this.wallet?.billingEnabled) {
        const billableUnits = extractDiscoveryBillableUnits(status, payload);
        const note = `DiscoveryRunCompleted:${status}`;
        // Read the bound attempt after backfill so an early completion can settle its original hold.
        const attempt = await tx.taskRun.findUnique({
          where: { workspaceId, engineRunId: runId },
          select: { id: true },
        });
        if (attempt) {
          await this.wallet.settleHoldByRef(
            workspaceId, DISCOVERY_TASK_RUN_WALLET_REF, attempt.id, billableUnits, note, 'system:event-consumer',
          );
        }
        await this.wallet.settleHoldByRef(
          workspaceId,
          'discovery_run',
          runId,
          billableUnits,
          note,
          'system:event-consumer',
        );
      }
      return;
    }

    if (type === 'CandidateBatchCompleted') {
      // M2 步 10：候选批次日志在此只吸收（event_inbox 已存完整 payload）；批次产出/判定分布的
      // 运营归因聚合读 event_inbox，不再落业务表。旧 run 回放（最小/缺字段载荷）必须不报错。
      return;
    }

    if (type === 'SanctionsListStale') {
      // ch08 §3.1.12：制裁名单过期/临近过期（L0 门与 accept 第五道硬门同源告警）。
      // 24h 限频按严重级别分流：yellow 告警绝不可吞掉后续升级为 red 的阻断告警！
      const freshness = payload.freshness === 'yellow' ? 'yellow' : 'red';
      const recent = await tx.notification.findFirst({
        where: {
          workspaceId,
          type: 'SanctionsListStale',
          createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) },
          ...(freshness === 'red' ? { title: { contains: '暂时无法接受新线索' } } : {}),
        },
        select: { id: true },
      });
      if (recent) return;
      const icpId = typeof payload.icpId === 'string' && UUID.test(payload.icpId) ? payload.icpId : aggregateId;
      await this.notify(
        tx,
        workspaceId,
        'SanctionsListStale',
        icpId,
        freshness === 'yellow'
          ? '制裁名单临近更新时限，接受新线索可能被暂缓'
          : '制裁名单已过更新时限，暂时无法接受新线索',
        freshness === 'yellow'
          ? 'The sanctions list is nearing its refresh deadline — accepting new leads may be paused'
          : 'The sanctions list is past its refresh deadline — accepting new leads is paused for now',
      );
      return;
    }

    if (type === 'DeletionCompleted') {
      const refId =
        (typeof payload.deletion_request_id === 'string' && payload.deletion_request_id) ||
        (typeof payload.deletionRequestId === 'string' && payload.deletionRequestId) ||
        aggregateId;
      await this.cascadeDeletionCompleted(tx, event, refId);
      await this.notify(
        tx,
        workspaceId,
        'DeletionCompleted',
        refId,
        '数据删除请求（GDPR Art.17）已完成，相关个人数据已擦除',
        'Data erasure request (GDPR Art.17) completed — personal data has been removed',
      );
      return;
    }

    if (type === 'ClaimRevoked') {
      const claimId =
        (typeof payload.claimId === 'string' && payload.claimId) || aggregateId;
      await this.notify(
        tx,
        workspaceId,
        'ClaimRevoked',
        claimId,
        '一条已批准的企业事实已被撤销，相关后续生成将不再引用',
        'An approved company fact was revoked and will no longer be used in future drafts',
      );
      return;
    }

    if (type === 'SiteBuildCostSummaryUpdated') {
      const budget = isObject(payload.budget) ? payload.budget : null;
      const spentCents =
        typeof budget?.spentCents === 'number' && Number.isFinite(budget.spentCents) && budget.spentCents > 0
          ? budget.spentCents
          : 0;
      if (spentCents > 0) {
        const INT4_MAX = 2_147_483_647;
        const amountMicros = Math.min(Math.round(spentCents * 10_000), INT4_MAX);
        await tx.costLedger.createMany({
          data: [{ workspaceId, sourceEventId: event.eventId, amountMicros, occurredAt: event.occurredAt }],
          skipDuplicates: true,
        });
      }
      return;
    }

    if (type === 'CampaignPlanJobFailed') {
      // ch08 §3.1.4 双通道兜底：控制面 PATCH 重试耗尽后引擎发此事件。
      // 把仍处 PENDING/RUNNING 的方案 job 置 FAILED（payload.jobId 即 SaaS 的
      // campaign_plan_job.id）；已终结的幂等跳过。issues 为引擎有界清单，透传存证。
      const jobId = typeof payload.jobId === 'string' && UUID.test(payload.jobId) ? payload.jobId : '';
      if (!jobId) return;
      const error = typeof payload.error === 'string' && payload.error ? payload.error.slice(0, 200) : 'CAMPAIGN_PLAN_JOB_FAILED';
      const issues = Array.isArray(payload.issues) ? (payload.issues as Prisma.InputJsonValue) : undefined;
      const updated = await tx.campaignPlanJob.updateMany({
        where: { id: jobId, workspaceId, state: { in: ['PENDING', 'RUNNING'] } },
        data: { state: 'FAILED', error, ...(issues !== undefined ? { issues } : {}) },
      });
      if (updated.count !== 1) return; // 已被主通道(PATCH)终结 → 幂等
      const campaignId = typeof payload.campaignId === 'string' ? payload.campaignId : jobId;
      await this.notify(
        tx,
        workspaceId,
        'CampaignPlanJobFailed',
        campaignId,
        '战役方案生成失败，可在战役页重新发起',
        'The campaign plan failed to generate — you can start it again on the campaign page',
      );
      return;
    }

    // 单条事实审批不生成站内通知：一次理解会产生上百条 Claim，逐条通知会把铃铛淹没。
    // 审批结果仍在企业事实页与审计中可见。
  }

  private async cascadeDeletionCompleted(
    tx: Prisma.TransactionClient,
    event: ProjectionEvent,
    refId: string,
  ): Promise<void> {
    const workspaceId = event.workspaceId;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const rawSubjectType = text(payload.subject_type) || text(payload.subjectType);
    const rawSubjectRef = text(payload.subject_ref) || text(payload.subjectRef);
    const rawErasedContacts = Array.isArray(payload.erased_contact_refs)
      ? payload.erased_contact_refs
      : Array.isArray(payload.erasedContactRefs)
        ? payload.erasedContactRefs
        : [];

    const contactRefSet = new Set<string>();
    if (rawSubjectType === 'contact' && UUID.test(rawSubjectRef)) {
      contactRefSet.add(rawSubjectRef.toLowerCase());
    }
    for (const item of rawErasedContacts) {
      if (typeof item === 'string' && UUID.test(item)) {
        contactRefSet.add(item.toLowerCase());
      }
    }
    const contactRefs = [...contactRefSet];
    const companyRef =
      rawSubjectType === 'company' && UUID.test(rawSubjectRef)
        ? rawSubjectRef.toLowerCase()
        : null;

    if (!companyRef && contactRefs.length === 0) {
      return;
    }

    let saasDeleted = 0;
    const deletionRequestId = refId || event.eventId;
    const targetRefs = new Set<string>([...contactRefs, ...(companyRef ? [companyRef] : [])]);
    const matchedDraftIds = new Set<string>();

    if (contactRefs.length > 0) {
      const matchedDrafts = await tx.outreachDraft.findMany({
        where: { workspaceId, contactRef: { in: contactRefs } },
        select: { id: true, batchId: true, contactPointId: true },
      });
      const draftIds = matchedDrafts.map((d) => d.id);
      for (const draftId of draftIds) matchedDraftIds.add(draftId.toLowerCase());
      const contactPointIds = [
        ...new Set(matchedDrafts.map((d) => d.contactPointId).filter((id): id is string => typeof id === 'string' && id.length > 0)),
      ];

      if (draftIds.length > 0) {
        saasDeleted += (await tx.outreachSendJob.deleteMany({ where: { workspaceId, draftId: { in: draftIds } } })).count;
        saasDeleted += (await tx.outreachSend.deleteMany({ where: { workspaceId, draftId: { in: draftIds } } })).count;
      }
      if (contactPointIds.length > 0) {
        saasDeleted += (
          await tx.outreachBounceWriteback.deleteMany({
            where: { workspaceId, contactPointId: { in: contactPointIds } },
          })
        ).count;
      }

      saasDeleted += (await tx.outreachDraft.deleteMany({ where: { workspaceId, contactRef: { in: contactRefs } } })).count;
      saasDeleted += (await tx.outreachReply.deleteMany({ where: { workspaceId, contactRef: { in: contactRefs } } })).count;
      saasDeleted += (
        await tx.outreachUnsubscribeToken.deleteMany({ where: { workspaceId, contactRef: { in: contactRefs } } })
      ).count;
      saasDeleted += (await tx.outreachConsent.deleteMany({ where: { workspaceId, contactRef: { in: contactRefs } } })).count;

      const matchedBases = await tx.outreachCallBasis.findMany({
        where: { workspaceId, contactRef: { in: contactRefs } },
        select: { id: true },
      });
      const basisIds = matchedBases.map((b) => b.id);
      if (basisIds.length > 0) {
        saasDeleted += (
          await tx.outreachCallAttempt.deleteMany({ where: { workspaceId, basisId: { in: basisIds } } })
        ).count;
      }
      saasDeleted += (await tx.outreachCallBasis.deleteMany({ where: { workspaceId, contactRef: { in: contactRefs } } })).count;
      saasDeleted += (
        await tx.outreachExperimentAssignment.deleteMany({
          where: { workspaceId, subjectType: 'contact', subjectRef: { in: contactRefs } },
        })
      ).count;
    }

    const matchedRefs = new Set<string>([...targetRefs, ...matchedDraftIds]);

    const batchEvents = await tx.outreachBatchEvent.findMany({
      where: { workspaceId },
      select: { id: true, detail: true },
    });
    for (const batchEvent of batchEvents) {
      if (jsonContainsUuidRef(batchEvent.detail, matchedRefs)) {
        await tx.outreachBatchEvent.update({
          where: { id: batchEvent.id },
          data: {
            detail: {
              redacted: true,
              reason: 'GDPR_ART17',
              deletionRequestId,
            },
          },
        });
        saasDeleted += 1;
      }
    }

    const auditPackages = await tx.outreachAuditPackage.findMany({
      where: { workspaceId },
      select: { id: true, package: true },
    });
    for (const pkgRow of auditPackages) {
      const scrubbed = scrubAuditPackage(pkgRow.package, contactRefSet, matchedRefs, deletionRequestId);
      if (scrubbed.changed) {
        await tx.outreachAuditPackage.update({
          where: { id: pkgRow.id },
          data: { package: scrubbed.value as Prisma.InputJsonValue },
        });
        saasDeleted += 1;
      }
    }

    if (companyRef) {
      const matchedQgos = await tx.qgo.findMany({
        where: { workspaceId, canonicalCompanyRef: companyRef },
        select: { id: true, leadRef: true, sao: { select: { id: true } } },
      });
      const qgoIds = matchedQgos.map((q) => q.id);
      const saoIds = matchedQgos
        .map((q) => q.sao?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      const matchedLeadRefs = new Set(matchedQgos.map((q) => q.leadRef.toLowerCase()));

      if (saoIds.length > 0) {
        saasDeleted += (
          await tx.opportunityOutcome.deleteMany({ where: { workspaceId, saoId: { in: saoIds } } })
        ).count;
      }
      if (qgoIds.length > 0) {
        saasDeleted += (await tx.sao.deleteMany({ where: { workspaceId, qgoId: { in: qgoIds } } })).count;
      }
      saasDeleted += (await tx.qgo.deleteMany({ where: { workspaceId, canonicalCompanyRef: companyRef } })).count;
      saasDeleted += (
        await tx.outreachExperimentAssignment.deleteMany({
          where: { workspaceId, subjectType: 'account', subjectRef: companyRef },
        })
      ).count;

      const qualifiedLeads = await tx.qualifiedLead.findMany({
        where: { workspaceId },
        select: { id: true, leadId: true, snapshot: true },
      });
      const matchedQualifiedIds = qualifiedLeads
        .filter(
          (row) =>
            matchedLeadRefs.has(row.leadId.toLowerCase()) ||
            jsonContainsUuidRef(row.snapshot, targetRefs),
        )
        .map((row) => row.id);
      if (matchedQualifiedIds.length > 0) {
        saasDeleted += (
          await tx.qualifiedLead.deleteMany({
            where: { workspaceId, id: { in: matchedQualifiedIds } },
          })
        ).count;
      }
    } else if (contactRefs.length > 0) {
      const qualifiedLeads = await tx.qualifiedLead.findMany({
        where: { workspaceId },
        select: { id: true, leadId: true, snapshot: true },
      });
      for (const row of qualifiedLeads) {
        const scrubbed = scrubQualifiedLeadContacts(row.snapshot, contactRefSet);
        if (scrubbed.changed) {
          await tx.qualifiedLead.update({
            where: { id: row.id },
            data: { snapshot: scrubbed.value as Prisma.InputJsonValue },
          });
          saasDeleted += 1;
        }
      }
    }

    const inboxRows = await tx.eventInbox.findMany({
      where: {
        workspaceId,
        eventId: { not: event.eventId },
        type: { not: 'DeletionCompleted' },
      },
      select: { id: true, eventId: true, type: true, payload: true },
    });
    for (const row of inboxRows) {
      if (jsonContainsUuidRef(row.payload, targetRefs)) {
        await tx.eventInbox.update({
          where: { id: row.id },
          data: {
            payload: {
              redacted: true,
              reason: 'GDPR_ART17',
              deletionRequestId,
            },
          },
        });
        saasDeleted += 1;
      }
    }

    if (refId) {
      await tx.deletionMirror.upsert({
        where: { engineRequestId: refId },
        create: {
          workspaceId,
          engineRequestId: refId,
          status: 'COMPLETED',
          saasDeleted,
        },
        update: {
          status: 'COMPLETED',
          saasDeleted,
          at: new Date(),
        },
      });
    }
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

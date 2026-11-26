import { randomUUID } from 'node:crypto';
import type { WalletActionCode } from '@gain-saas/shared';

export interface BffWalletActionSpec {
  readonly actionCode: WalletActionCode;
  readonly refType: string;
  readonly mode: 'async' | 'sync';
  readonly refParam: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DISCOVERY_WALLET_ACTION = 'DISCOVERY_QUALIFIED_LEAD';
export const DISCOVERY_TASK_RUN_WALLET_REF = 'discovery_task_run';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asNonNegativeInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return null;
}

/**
 * 映射核心收费 BFF 写路由到充值钱包动作：
 * - 企业建档、理解重试、生成 ICP、生成寻源方案全部免费（返回 null）；
 * - 发起寻源（异步按有效合格线索结算）、发现联系人/补全联系人/邮箱验真（同步按有效产出结算）。
 */
export function resolveBffWalletAction(
  method: string,
  enginePath: string,
): BffWalletActionSpec | null {
  if (method !== 'POST') return null;
  switch (enginePath) {
    case '/query-plans/:planId/execute':
      return {
        actionCode: DISCOVERY_WALLET_ACTION,
        refType: 'discovery_run',
        mode: 'async',
        refParam: 'planId',
      };
    case '/contact-points/:pointId/verify':
      return {
        actionCode: 'CONTACT_VALID_EMAIL',
        refType: 'contact_verify',
        mode: 'sync',
        refParam: 'pointId',
      };
    case '/canonical-companies/:id/discover-contacts':
      return {
        actionCode: 'CONTACT_DISCOVER',
        refType: 'contact_discover',
        mode: 'sync',
        refParam: 'id',
      };
    case '/canonical-companies/:id/enrich-contacts':
      return {
        actionCode: 'CONTACT_ENRICH',
        refType: 'contact_enrich',
        mode: 'sync',
        refParam: 'id',
      };
    default:
      return null;
  }
}

export function buildBffHoldIdempotencyKey(
  spec: BffWalletActionSpec,
  refId: string,
  headerKey?: string,
  body?: unknown,
): string {
  if (headerKey && headerKey.trim()) {
    return `bff:${spec.refType}:${headerKey.trim()}`.slice(0, 160);
  }
  const attemptId = isRecord(body) ? body.attemptId : undefined;
  if (typeof attemptId === 'string' && attemptId.trim()) {
    return `bff:${spec.refType}:${refId}:${attemptId.trim()}`.slice(0, 160);
  }
  return `bff:${spec.refType}:${refId}:${randomUUID()}`.slice(0, 160);
}

function unwrapData(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  if (isRecord(body.data)) return body.data;
  return body;
}

export function extractDiscoveryRunId(body: unknown): string | null {
  const data = unwrapData(body);
  if (!data) return null;
  for (const key of ['id', 'runId', 'run_id'] as const) {
    const val = data[key];
    if (typeof val === 'string' && UUID_RE.test(val)) return val;
  }
  return null;
}

/**
 * 从真实引擎 DiscoveryRunCompleted 事件 payload 提取计费有效线索数：
 * - FAILED / CANCELLED 一律返回 0（0 扣费 100% 退全款）；
 * - Run 2.0 优先读取 payload.stats.quickScan.leads（兼容 quick_scan.leads）；
 * - Run 1.0 读取 payload.stats.fit.match（兼容 stats.verdicts.match）；
 * - 最后兼容历史顶层字段（qualified_count / qualifiedCount / leads_created / leadsCreated / qualified_leads）。
 */
export function extractDiscoveryBillableUnits(
  status: string,
  payload: Record<string, unknown>,
): number {
  if (status !== 'DONE' && status !== 'PARTIAL') return 0;

  if (isRecord(payload.stats)) {
    const stats = payload.stats;
    if (isRecord(stats.quickScan)) {
      const n = asNonNegativeInt(stats.quickScan.leads);
      if (n !== null) return n;
    }
    if (isRecord(stats.quick_scan)) {
      const n = asNonNegativeInt(stats.quick_scan.leads);
      if (n !== null) return n;
    }
    if (isRecord(stats.fit)) {
      const n = asNonNegativeInt(stats.fit.match);
      if (n !== null) return n;
    }
    if (isRecord(stats.verdicts)) {
      const n = asNonNegativeInt(stats.verdicts.match);
      if (n !== null) return n;
    }
  }

  for (const key of [
    'qualified_count',
    'qualifiedCount',
    'leads_created',
    'leadsCreated',
    'qualified_leads',
  ] as const) {
    const n = asNonNegativeInt(payload[key]);
    if (n !== null) return n;
  }

  return 0;
}

/**
 * 同步收费动作按真实有效产出计算计费单位数（失败/空跑/非 VALID 邮箱/缓存复用均为 0 → 100% 自动退点）。
 */
export function extractSyncBillableUnits(actionCode: WalletActionCode, body: unknown): number {
  const data = unwrapData(body);
  if (!data) return 0;

  if (actionCode === 'CONTACT_VALID_EMAIL') {
    const nestedVerificationStatus = isRecord(data.verification)
      ? data.verification.status
      : undefined;
    const status = String(
      data.status ?? data.state ?? data.verdict ?? nestedVerificationStatus ?? '',
    ).toUpperCase();
    return status === 'VALID' ? 1 : 0;
  }

  if (actionCode === 'CONTACT_DISCOVER') {
    const discovered = asNonNegativeInt(data.discoveredCount);
    if (discovered !== null) return discovered;
    if (Array.isArray(data.contacts)) {
      return data.contacts.length;
    }
    const created = asNonNegativeInt(data.created);
    if (created !== null) return created;
    return 0;
  }

  if (actionCode === 'CONTACT_ENRICH') {
    // 真实引擎 wire schema：POST /api/v1/canonical-companies/:id/enrich-contacts 返回
    // { data: { companyId, tier, attempted, costMicrousd, deadlineHit, results: Array<{ contactId, status }> } }
    // 仅新富集落库的 status === 'stored' 计费；命中缓存复用（'reused'）与失败项不收费。
    if (Array.isArray(data.results)) {
      let stored = 0;
      for (const item of data.results) {
        if (isRecord(item) && String(item.status ?? '').toLowerCase() === 'stored') {
          stored += 1;
        }
      }
      return stored;
    }
    for (const key of [
      'validEmailCount',
      'enrichedCount',
      'valid_email_count',
      'enriched_count',
    ] as const) {
      const n = asNonNegativeInt(data[key]);
      if (n !== null) return n;
    }
    if (Array.isArray(data.contacts)) {
      return data.contacts.length;
    }
    return 0;
  }

  return 0;
}

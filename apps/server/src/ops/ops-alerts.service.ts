import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../config/configuration.js';
import { APP_CONFIG } from '../shared/config.module.js';
import { PrismaService } from '../shared/prisma.service.js';
import { OpsDatabase } from './ops-database.service.js';

export type OpsAlertSeverity = 'OK' | 'WARN' | 'CRITICAL';

export type OpsAlertCode =
  | 'SANCTIONS_FRESHNESS'
  | 'OUTREACH_DELIVERABILITY_HEALTH'
  | 'ENRICHMENT_PROVIDER_ERRORS'
  | 'WALLET_STUCK_HOLDS'
  | 'RUNTIME_ENGINE_AND_QUEUES';

export interface OpsAlertItem {
  readonly code: OpsAlertCode;
  readonly title: string;
  readonly severity: OpsAlertSeverity;
  readonly summary: string;
  readonly metric: Record<string, unknown>;
  readonly remediation: string;
}

export interface OpsAlertsReport {
  readonly status: OpsAlertSeverity;
  readonly checkedAt: string;
  readonly counts: {
    readonly critical: number;
    readonly warn: number;
    readonly ok: number;
  };
  readonly alerts: readonly OpsAlertItem[];
}

export interface OpsAlertEvaluationSignals {
  readonly now: Date;
  readonly sanctionsSources: readonly {
    readonly key: string;
    readonly status: string;
    readonly recordCount: number;
    readonly lastRefreshedAt: Date | null;
    readonly lastFetchStatus: string | null;
  }[];
  readonly outreachHealth: {
    readonly openBreakers: number;
    readonly halfOpenBreakers: number;
    readonly haltedMailboxes: number;
    readonly degradedMailboxes: number;
  };
  readonly providerStats24h: readonly {
    readonly providerKey: string;
    readonly total: number;
    readonly errors: number;
    readonly rateLimited: number;
  }[];
  readonly walletStuckHolds: {
    readonly expiredHeldCount: number;
    readonly oldestExpiredMinutes: number | null;
  };
  readonly runtimeHealth: {
    readonly engineReady: boolean;
    readonly engineDetail: string | null;
    readonly staleWorkerRoles: readonly string[];
    readonly deadOutboxCount: number;
    readonly stuckSendJobsCount: number;
  };
}

const DAY_MS = 86_400_000;
const STALE_LEASE_MS = 5 * 60_000;
const STUCK_CLAIM_MS = 30 * 60_000;
const WORKSPACE_SCAN_LIMIT = 200;

function maxSeverity(severities: readonly OpsAlertSeverity[]): OpsAlertSeverity {
  if (severities.includes('CRITICAL')) return 'CRITICAL';
  if (severities.includes('WARN')) return 'WARN';
  return 'OK';
}

/**
 * 纯函数评估 5 项生产不可静默告警：
 * 1) 制裁名单新鲜度；2) 外发退信/投诉熔断与信箱健康；3) 邮箱找寻/验真供应商错误飙升；
 * 4) 预充值钱包超时未释预占单；5) 核心引擎/Worker 租约/卡死队列。
 */
export function evaluateOperationalAlerts(signals: OpsAlertEvaluationSignals): OpsAlertsReport {
  const alerts: OpsAlertItem[] = [];
  const nowMs = signals.now.getTime();

  // 1. 制裁名单新鲜度告警
  const enabledSanctions = signals.sanctionsSources.filter((s) => s.status === 'ENABLED');
  const failedSources = enabledSanctions.filter(
    (s) => s.lastFetchStatus !== 'DONE' || s.recordCount <= 0 || !s.lastRefreshedAt,
  );
  const maxAgeDays = enabledSanctions.reduce<number>((acc, s) => {
    if (!s.lastRefreshedAt) return Number.POSITIVE_INFINITY;
    return Math.max(acc, (nowMs - s.lastRefreshedAt.getTime()) / DAY_MS);
  }, 0);
  if (enabledSanctions.length === 0 || failedSources.length > 0 || maxAgeDays > 7) {
    alerts.push({
      code: 'SANCTIONS_FRESHNESS',
      title: '制裁名单新鲜度与同步健康',
      severity: 'CRITICAL',
      summary:
        enabledSanctions.length === 0
          ? '未检测到任何已启用的官方制裁名单源'
          : failedSources.length > 0
            ? `${failedSources.map((s) => s.key).join(', ')} 最近同步失败或记录为 0`
            : `制裁名单距上次同步已超过 7 天（最旧 ${maxAgeDays.toFixed(1)} 天）`,
      metric: {
        enabledSources: enabledSanctions.length,
        failedSources: failedSources.map((s) => s.key),
        maxAgeDays: Number.isFinite(maxAgeDays) ? Number(maxAgeDays.toFixed(2)) : null,
      },
      remediation: '立即在宿主机检查出网代理并重跑官方制裁名单刷新（eu_fsf / ofac_sdn / ofac_consolidated）。',
    });
  } else if (maxAgeDays > 5) {
    alerts.push({
      code: 'SANCTIONS_FRESHNESS',
      title: '制裁名单新鲜度与同步健康',
      severity: 'WARN',
      summary: `制裁名单距上次同步已 ${maxAgeDays.toFixed(1)} 天，接近 7 天合规红线`,
      metric: {
        enabledSources: enabledSanctions.length,
        maxAgeDays: Number(maxAgeDays.toFixed(2)),
      },
      remediation: '确认 sanctions-refresh 调度正常运行，避免超过 7 天触发 fail-closed 拦截。',
    });
  } else {
    alerts.push({
      code: 'SANCTIONS_FRESHNESS',
      title: '制裁名单新鲜度与同步健康',
      severity: 'OK',
      summary: `${enabledSanctions.length} 个官方制裁名单均在 5 天内成功同步`,
      metric: {
        enabledSources: enabledSanctions.length,
        maxAgeDays: Number(maxAgeDays.toFixed(2)),
      },
      remediation: '无需操作。',
    });
  }

  // 2. 外发熔断与信箱健康
  const { openBreakers, halfOpenBreakers, haltedMailboxes, degradedMailboxes } = signals.outreachHealth;
  if (openBreakers > 0 || haltedMailboxes > 0) {
    alerts.push({
      code: 'OUTREACH_DELIVERABILITY_HEALTH',
      title: '外发退信/投诉熔断与信箱健康',
      severity: 'CRITICAL',
      summary: `存在 ${openBreakers} 个已熔断（OPEN）断路器、${haltedMailboxes} 个停发（HALTED）信箱`,
      metric: signals.outreachHealth,
      remediation: '暂停问题域名/信箱外发，排查硬退信/投诉样本与 SPF/DKIM/DMARC 配置后再人工恢复。',
    });
  } else if (halfOpenBreakers > 0 || degradedMailboxes > 0) {
    alerts.push({
      code: 'OUTREACH_DELIVERABILITY_HEALTH',
      title: '外发退信/投诉熔断与信箱健康',
      severity: 'WARN',
      summary: `存在 ${halfOpenBreakers} 个半开恢复中断路器、${degradedMailboxes} 个降级信箱`,
      metric: signals.outreachHealth,
      remediation: '持续观察小批恢复期退信率，保持低于 2% 预警线。',
    });
  } else {
    alerts.push({
      code: 'OUTREACH_DELIVERABILITY_HEALTH',
      title: '外发退信/投诉熔断与信箱健康',
      severity: 'OK',
      summary: '所有外发断路器与发件信箱均处于正常状态',
      metric: signals.outreachHealth,
      remediation: '无需操作。',
    });
  }

  // 3. 外部联系人富集/验真供应商异常率
  const badProviders = signals.providerStats24h
    .filter((p) => p.total >= 10)
    .map((p) => ({
      ...p,
      errorRate: p.errors / p.total,
      rateLimitRate: p.rateLimited / p.total,
    }))
    .filter((p) => p.errorRate >= 0.5);
  const criticalProviders = badProviders.filter((p) => p.errorRate >= 0.7 || p.rateLimitRate >= 0.5);
  if (criticalProviders.length > 0) {
    alerts.push({
      code: 'ENRICHMENT_PROVIDER_ERRORS',
      title: '外部邮箱找寻/验真供应商异常率',
      severity: 'CRITICAL',
      summary: `${criticalProviders.map((p) => `${p.providerKey}(${Math.round(p.errorRate * 100)}%)`).join(', ')} 近 24 小时报错或 429 限流严重`,
      metric: {
        providers: badProviders.map((p) => ({
          providerKey: p.providerKey,
          total: p.total,
          errors: p.errors,
          rateLimited: p.rateLimited,
          errorRate: Number(p.errorRate.toFixed(3)),
        })),
      },
      remediation: '核查对应供应商额度/密钥状态，及时充值续费或在 data_provider 中停用以防拖慢寻源。',
    });
  } else if (badProviders.length > 0) {
    alerts.push({
      code: 'ENRICHMENT_PROVIDER_ERRORS',
      title: '外部邮箱找寻/验真供应商异常率',
      severity: 'WARN',
      summary: `${badProviders.map((p) => `${p.providerKey}(${Math.round(p.errorRate * 100)}%)`).join(', ')} 近 24 小时错误率超过 50%`,
      metric: { providers: badProviders },
      remediation: '检查供应商限速配置与剩余配额。',
    });
  } else {
    alerts.push({
      code: 'ENRICHMENT_PROVIDER_ERRORS',
      title: '外部邮箱找寻/验真供应商异常率',
      severity: 'OK',
      summary: '近 24 小时外部富集与验真供应商错误率均在正常范围内',
      metric: { checkedProviders: signals.providerStats24h.length },
      remediation: '无需操作。',
    });
  }

  // 4. 预充值钱包过期滞留预占单
  const { expiredHeldCount, oldestExpiredMinutes } = signals.walletStuckHolds;
  if (expiredHeldCount >= 5 || (oldestExpiredMinutes !== null && oldestExpiredMinutes >= 120)) {
    alerts.push({
      code: 'WALLET_STUCK_HOLDS',
      title: '预充值钱包超时滞留预占单',
      severity: 'CRITICAL',
      summary: `有 ${expiredHeldCount} 笔预占单超过 TTL 仍未释放（最久滞留 ${oldestExpiredMinutes ?? 0} 分钟）`,
      metric: signals.walletStuckHolds,
      remediation: '检查 gain-saas-worker 中 WalletHoldSweeperService 运行日志并排查异步结算事件消费。',
    });
  } else if (expiredHeldCount > 0) {
    alerts.push({
      code: 'WALLET_STUCK_HOLDS',
      title: '预充值钱包超时滞留预占单',
      severity: 'WARN',
      summary: `有 ${expiredHeldCount} 笔预占单刚过 TTL，等待下轮扫地释放`,
      metric: signals.walletStuckHolds,
      remediation: '确认 WALLET_HOLD_SWEEP_ENABLED 或 WALLET_BILLING_ENABLED 已启用，10 分钟后复查。',
    });
  } else {
    alerts.push({
      code: 'WALLET_STUCK_HOLDS',
      title: '预充值钱包超时滞留预占单',
      severity: 'OK',
      summary: '无超时滞留未释放的积分预占单',
      metric: signals.walletStuckHolds,
      remediation: '无需操作。',
    });
  }

  // 5. 核心引擎、Worker 租约与任务队列健康
  const { engineReady, engineDetail, staleWorkerRoles, deadOutboxCount, stuckSendJobsCount } =
    signals.runtimeHealth;
  if (!engineReady || staleWorkerRoles.length > 0 || stuckSendJobsCount > 0) {
    const reasons: string[] = [];
    if (!engineReady) reasons.push(`引擎就绪检查失败(${engineDetail ?? 'unreachable'})`);
    if (staleWorkerRoles.length > 0) reasons.push(`Worker 租约超时(${staleWorkerRoles.join(', ')})`);
    if (stuckSendJobsCount > 0) reasons.push(`外发队列卡死 ${stuckSendJobsCount} 笔`);
    alerts.push({
      code: 'RUNTIME_ENGINE_AND_QUEUES',
      title: '核心引擎、Worker 租约与队列健康',
      severity: 'CRITICAL',
      summary: reasons.join('；'),
      metric: signals.runtimeHealth,
      remediation: '检查 global-api / global-worker / global-platform-worker 容器健康状态与 gain-saas-worker 日志。',
    });
  } else if (deadOutboxCount > 0) {
    alerts.push({
      code: 'RUNTIME_ENGINE_AND_QUEUES',
      title: '核心引擎、Worker 租约与队列健康',
      severity: 'WARN',
      summary: `引擎与 Worker 正常，但存在 ${deadOutboxCount} 条 DEAD 状态 Outbox 投递记录`,
      metric: signals.runtimeHealth,
      remediation: '排查 outbox_delivery DEAD 记录并确认是否需要重放或清理历史测试事件。',
    });
  } else {
    alerts.push({
      code: 'RUNTIME_ENGINE_AND_QUEUES',
      title: '核心引擎、Worker 租约与队列健康',
      severity: 'OK',
      summary: '核心引擎、Worker 心跳租约与外发队列均正常',
      metric: signals.runtimeHealth,
      remediation: '无需操作。',
    });
  }

  const critical = alerts.filter((a) => a.severity === 'CRITICAL').length;
  const warn = alerts.filter((a) => a.severity === 'WARN').length;
  const ok = alerts.filter((a) => a.severity === 'OK').length;

  return {
    status: maxSeverity(alerts.map((a) => a.severity)),
    checkedAt: signals.now.toISOString(),
    counts: { critical, warn, ok },
    alerts,
  };
}

/**
 * 运营域 5 条不可静默自动告警聚合服务（严格遵守 gain_saas FORCE RLS：逐活跃工作空间 withWorkspace 采样）。
 */
@Injectable()
export class OpsAlertsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly database: OpsDatabase,
  ) {}

  private async probeEngineReady(): Promise<{ ok: boolean; status?: string; error?: string }> {
    const base = this.config.ENGINE_ORIGIN.replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/api/v1/health/ready`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) return { ok: false, error: `http_${res.status}` };
      const body = (await res.json().catch(() => null)) as { status?: unknown } | null;
      const status = typeof body?.status === 'string' ? body.status : 'ok';
      return { ok: status === 'ok', status };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async evaluate(now: Date = new Date()): Promise<OpsAlertsReport> {
    const db = this.database.db;

    const [sanctionsRows, leaseRows, providerRows, deadOutboxRows, engineRes, activeWorkspaces] =
      await Promise.all([
        db
          .query(
            `SELECT key, status, record_count, last_refreshed_at, last_fetch_status FROM sanctions_source ORDER BY key`,
          )
          .catch(() => []),
        db
          .query(
            `SELECT DISTINCT ON (role) role, state, last_seen_at FROM runtime_process_lease ORDER BY role, last_seen_at DESC`,
          )
          .catch(() => []),
        db.ownerPool
          ? db
              .ownerQuery(
                `SELECT provider_key,
                        count(*)::int AS total,
                        count(*) FILTER (WHERE outcome = 'error')::int AS errors,
                        count(*) FILTER (WHERE error_code = 'rate_limited')::int AS rate_limited
                 FROM contact_enrichment_attempt
                 WHERE attempted_at > now() - interval '24 hours'
                 GROUP BY provider_key`,
              )
              .catch(() => [])
          : Promise.resolve([]),
        db.ownerPool
          ? db
              .ownerQuery(`SELECT count(*)::int AS n FROM outbox_delivery WHERE status = 'DEAD'`)
              .catch(() => [{ n: 0 }])
          : Promise.resolve([{ n: 0 }]),
        this.probeEngineReady(),
        this.prisma.workspace
          .findMany({
            where: { status: 'ACTIVE' },
            select: { id: true },
            take: WORKSPACE_SCAN_LIMIT,
          })
          .catch(() => []),
      ]);

    let openBreakers = 0;
    let halfOpenBreakers = 0;
    let haltedMailboxes = 0;
    let degradedMailboxes = 0;
    let expiredHeldCount = 0;
    let oldestExpiredAtMs: number | null = null;
    let stuckSendJobsCount = 0;
    const stuckBefore = new Date(now.getTime() - STUCK_CLAIM_MS);

    const chunkSize = 8;
    for (let i = 0; i < activeWorkspaces.length; i += chunkSize) {
      const batch = activeWorkspaces.slice(i, i + chunkSize);
      await Promise.all(
        batch.map(async (ws) => {
          try {
            const snap = await this.prisma.withWorkspace(ws.id, async (tx) => {
              const [breakers, mailboxes, expiredHolds, stuckJobs] = await Promise.all([
                tx.outreachBreaker.findMany({
                  where: { workspaceId: ws.id, state: { in: ['OPEN', 'HALF_OPEN'] } },
                  select: { state: true },
                }),
                tx.outreachMailbox.findMany({
                  where: { workspaceId: ws.id, state: { in: ['HALTED', 'DEGRADED'] } },
                  select: { state: true },
                }),
                tx.walletHold.findMany({
                  where: { workspaceId: ws.id, status: 'HELD', expiresAt: { lte: now } },
                  select: { expiresAt: true },
                }),
                tx.outreachSendJob.count({
                  where: {
                    workspaceId: ws.id,
                    state: 'CLAIMED',
                    claimedAt: { lte: stuckBefore },
                  },
                }),
              ]);
              return { breakers, mailboxes, expiredHolds, stuckJobs };
            });
            for (const b of snap.breakers) {
              if (b.state === 'OPEN') openBreakers += 1;
              else if (b.state === 'HALF_OPEN') halfOpenBreakers += 1;
            }
            for (const m of snap.mailboxes) {
              if (m.state === 'HALTED') haltedMailboxes += 1;
              else if (m.state === 'DEGRADED') degradedMailboxes += 1;
            }
            expiredHeldCount += snap.expiredHolds.length;
            for (const h of snap.expiredHolds) {
              const ms = h.expiresAt.getTime();
              if (oldestExpiredAtMs === null || ms < oldestExpiredAtMs) {
                oldestExpiredAtMs = ms;
              }
            }
            stuckSendJobsCount += snap.stuckJobs;
          } catch {
            // 单个空间采样失败不拖垮全局运营告警接口
          }
        }),
      );
    }

    const staleWorkerRoles = (leaseRows as Array<{ role?: unknown; last_seen_at?: unknown }>)
      .filter((row) => {
        const ts = row.last_seen_at ? new Date(String(row.last_seen_at)).getTime() : 0;
        return !Number.isFinite(ts) || now.getTime() - ts > STALE_LEASE_MS;
      })
      .map((row) => String(row.role ?? 'unknown'));

    const engineObj = engineRes as { ok?: unknown; status?: unknown; error?: unknown };
    const engineReady = engineObj.ok === true || engineObj.status === 'ok';
    const engineDetail = engineReady
      ? null
      : typeof engineObj.error === 'string'
        ? engineObj.error
        : typeof engineObj.status === 'string'
          ? engineObj.status
          : 'unhealthy';

    return evaluateOperationalAlerts({
      now,
      sanctionsSources: (sanctionsRows as Array<Record<string, unknown>>).map((row) => ({
        key: String(row.key ?? ''),
        status: String(row.status ?? ''),
        recordCount: Number(row.record_count ?? 0),
        lastRefreshedAt: row.last_refreshed_at ? new Date(String(row.last_refreshed_at)) : null,
        lastFetchStatus: row.last_fetch_status ? String(row.last_fetch_status) : null,
      })),
      outreachHealth: {
        openBreakers,
        halfOpenBreakers,
        haltedMailboxes,
        degradedMailboxes,
      },
      providerStats24h: (providerRows as Array<Record<string, unknown>>).map((row) => ({
        providerKey: String(row.provider_key ?? ''),
        total: Number(row.total ?? 0),
        errors: Number(row.errors ?? 0),
        rateLimited: Number(row.rate_limited ?? 0),
      })),
      walletStuckHolds: {
        expiredHeldCount,
        oldestExpiredMinutes:
          oldestExpiredAtMs !== null
            ? Math.max(0, Math.round((now.getTime() - oldestExpiredAtMs) / 60_000))
            : null,
      },
      runtimeHealth: {
        engineReady,
        engineDetail,
        staleWorkerRoles,
        deadOutboxCount: Number((deadOutboxRows[0] as { n?: unknown } | undefined)?.n ?? 0),
        stuckSendJobsCount,
      },
    });
  }
}

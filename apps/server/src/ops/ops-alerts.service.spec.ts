import { describe, expect, it } from 'vitest';
import {
  evaluateOperationalAlerts,
  type OpsAlertEvaluationSignals,
} from './ops-alerts.service.js';

const NOW = new Date('2026-11-28T02:00:00.000Z');

function healthySignals(): OpsAlertEvaluationSignals {
  const freshAt = new Date(NOW.getTime() - 6 * 3_600_000);
  return {
    now: NOW,
    sanctionsSources: [
      { key: 'eu_fsf', status: 'ENABLED', recordCount: 1798, lastRefreshedAt: freshAt, lastFetchStatus: 'DONE' },
      { key: 'ofac_sdn', status: 'ENABLED', recordCount: 10144, lastRefreshedAt: freshAt, lastFetchStatus: 'DONE' },
      { key: 'ofac_consolidated', status: 'ENABLED', recordCount: 368, lastRefreshedAt: freshAt, lastFetchStatus: 'DONE' },
    ],
    outreachHealth: {
      openBreakers: 0,
      halfOpenBreakers: 0,
      haltedMailboxes: 0,
      degradedMailboxes: 0,
    },
    providerStats24h: [
      { providerKey: 'prospeo', total: 66, errors: 15, rateLimited: 15 },
    ],
    walletStuckHolds: {
      expiredHeldCount: 0,
      oldestExpiredMinutes: null,
    },
    runtimeHealth: {
      engineReady: true,
      engineDetail: null,
      staleWorkerRoles: [],
      deadOutboxCount: 0,
      stuckSendJobsCount: 0,
    },
  };
}

describe('evaluateOperationalAlerts（5 项不可静默运维自动告警）', () => {
  it('全部指标正常时返回 OK（5 项全绿）', () => {
    const report = evaluateOperationalAlerts(healthySignals());
    expect(report.status).toBe('OK');
    expect(report.counts).toEqual({ critical: 0, warn: 0, ok: 5 });
    expect(report.alerts).toHaveLength(5);
  });

  it('制裁超 7 天、Hunter 高 429 报错、外发熔断、钱包滞留预占、引擎异常分别触发 CRITICAL', () => {
    const staleAt = new Date(NOW.getTime() - 8 * 86_400_000);
    const report = evaluateOperationalAlerts({
      now: NOW,
      sanctionsSources: [
        { key: 'eu_fsf', status: 'ENABLED', recordCount: 1798, lastRefreshedAt: staleAt, lastFetchStatus: 'DONE' },
      ],
      outreachHealth: {
        openBreakers: 1,
        halfOpenBreakers: 0,
        haltedMailboxes: 1,
        degradedMailboxes: 0,
      },
      providerStats24h: [
        { providerKey: 'hunter', total: 104, errors: 79, rateLimited: 65 },
      ],
      walletStuckHolds: {
        expiredHeldCount: 6,
        oldestExpiredMinutes: 180,
      },
      runtimeHealth: {
        engineReady: false,
        engineDetail: 'http_503',
        staleWorkerRoles: ['platform-worker'],
        deadOutboxCount: 2,
        stuckSendJobsCount: 3,
      },
    });
    expect(report.status).toBe('CRITICAL');
    expect(report.counts).toEqual({ critical: 5, warn: 0, ok: 0 });
    expect(report.alerts.find((a) => a.code === 'ENRICHMENT_PROVIDER_ERRORS')?.summary).toContain('hunter');
    expect(report.alerts.find((a) => a.code === 'SANCTIONS_FRESHNESS')?.summary).toContain('7 天');
    expect(report.alerts.find((a) => a.code === 'WALLET_STUCK_HOLDS')?.summary).toContain('6 笔');
  });

  it('边界预警档（5~7 天制裁、半开断路器、单笔刚过期预占、DEAD outbox）输出 WARN', () => {
    const warnAt = new Date(NOW.getTime() - 5.5 * 86_400_000);
    const report = evaluateOperationalAlerts({
      ...healthySignals(),
      sanctionsSources: [
        { key: 'eu_fsf', status: 'ENABLED', recordCount: 1798, lastRefreshedAt: warnAt, lastFetchStatus: 'DONE' },
      ],
      outreachHealth: {
        openBreakers: 0,
        halfOpenBreakers: 1,
        haltedMailboxes: 0,
        degradedMailboxes: 0,
      },
      providerStats24h: [
        { providerKey: 'zerobounce', total: 20, errors: 11, rateLimited: 0 },
      ],
      walletStuckHolds: {
        expiredHeldCount: 1,
        oldestExpiredMinutes: 15,
      },
      runtimeHealth: {
        engineReady: true,
        engineDetail: null,
        staleWorkerRoles: [],
        deadOutboxCount: 1,
        stuckSendJobsCount: 0,
      },
    });
    expect(report.status).toBe('WARN');
    expect(report.counts).toEqual({ critical: 0, warn: 5, ok: 0 });
  });
});

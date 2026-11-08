import { describe, expect, it, vi } from 'vitest';
import { OpsCampaignMetricsService, utcWeekStart } from './ops-campaign-metrics.service.js';
import { diffPlanLeaves, modificationDistance } from './campaign-plan-diff.js';

const WS = '11111111-1111-4111-8111-111111111111';
const C1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const C2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-11-08T12:00:00Z');
const FROM = new Date('2026-11-01T00:00:00Z');
const TO = new Date('2026-11-08T12:00:00Z');

type Rows = Record<string, unknown>[];

function approval(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'appr',
    revisionId: 'rev-1',
    state: 'APPROVED',
    decidedAt: new Date('2026-11-03T10:00:00Z'),
    expiresAt: new Date('2026-11-10T10:00:00Z'),
    createdAt: new Date('2026-11-03T09:00:00Z'),
    revision: { campaignId: C1 },
    ...overrides,
  };
}

function makeService(options: {
  approvals?: Rows;
  revisions?: Rows;
  traces?: Rows;
  engineQuery?: () => Promise<Rows>;
}) {
  const revisionCalls: Rows[] = [];
  const prisma = {
    campaignApproval: { findMany: vi.fn(async () => options.approvals ?? []) },
    campaignRevision: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        const all = (options.revisions ?? []) as Record<string, unknown>[];
        const where = args.where ?? {};
        const byId = (where['id'] as { in?: string[] } | undefined)?.in;
        const byCampaign = (where['campaignId'] as { in?: string[] } | undefined)?.in;
        const rows = byId
          ? all.filter((row) => byId.includes(String(row['id'])))
          : byCampaign
            ? all.filter((row) => byCampaign.includes(String(row['campaignId'])))
            : all;
        revisionCalls.push(rows);
        return rows;
      }),
    },
    campaignDecisionTrace: { findMany: vi.fn(async () => options.traces ?? []) },
  };
  const engine = { query: vi.fn(options.engineQuery ?? (async () => [])) };
  const service = new OpsCampaignMetricsService(prisma as never, { db: engine } as never);
  return { service, prisma, engine };
}

describe('utcWeekStart', () => {
  it('returns Monday 00:00 UTC', () => {
    expect(utcWeekStart(new Date('2026-11-08T12:34:56Z')).toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(utcWeekStart(new Date('2026-11-02T00:00:00Z')).toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(utcWeekStart(new Date('2026-11-01T23:59:59Z')).toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });
});

describe('campaign-plan-diff', () => {
  it('counts added/removed/changed leaves and reports zero for identical plans', () => {
    expect(modificationDistance({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toBe(0);
    expect(modificationDistance({ a: 1 }, { a: 2, c: 3 })).toBe(2);
    expect(diffPlanLeaves({ a: 1 }, { a: 1, b: { c: 2 } })).toEqual({
      added: ['b.c'],
      removed: [],
      changed: [],
    });
  });
});

describe('OpsCampaignMetricsService.campaignMetrics', () => {
  it('computes the approval rate with lazy expiry (PENDING past expiresAt counts as EXPIRED)', async () => {
    const { service } = makeService({
      approvals: [
        approval({ id: 'a1', state: 'APPROVED' }),
        approval({ id: 'a2', state: 'DECLINED', revisionId: 'rev-2' }),
        approval({
          id: 'a3',
          state: 'PENDING',
          revisionId: 'rev-3',
          decidedAt: null,
          expiresAt: new Date('2026-11-04T00:00:00Z'),
        }),
        approval({
          id: 'a4',
          state: 'PENDING',
          revisionId: 'rev-4',
          decidedAt: null,
          expiresAt: new Date('2026-11-09T00:00:00Z'),
        }),
      ],
      revisions: [{ id: 'rev-1', campaignId: C1, revisionNo: 1, plan: { goal: { objective: 'x' } } }],
    });
    const result = await service.campaignMetrics({ workspaceId: WS, from: FROM, to: TO, now: NOW });
    expect(result.approvals).toMatchObject({ approved: 1, declined: 1, expired: 1, pending: 1 });
    expect(result.approvals.approvalRate).toBeCloseTo(1 / 3, 4);
    expect(result.approvals.rateDenominator).toBe(3);
    expect(result.weekly.length).toBeGreaterThanOrEqual(1);
    expect(result.weekly[0]?.weekStart).toBe('2026-11-02T00:00:00.000Z');
    expect(result.replyMeetingRate.status).toBe('reserved');
  });

  it('measures the modification distance between the approved revision and the first draft', async () => {
    const { service, prisma } = makeService({
      approvals: [approval({ id: 'a1', revisionId: 'rev-2', state: 'APPROVED' })],
      revisions: [
        { id: 'rev-1', campaignId: C1, revisionNo: 1, plan: { goal: { objective: 'a' }, budget: { capMicros: 10 } } },
        { id: 'rev-2', campaignId: C1, revisionNo: 2, plan: { goal: { objective: 'b' }, budget: { capMicros: 10 } } },
      ],
    });
    const result = await service.campaignMetrics({ workspaceId: WS, from: FROM, to: TO, now: NOW });
    expect(result.modification.approvedPlans).toBe(1);
    expect(result.modification.perCampaign).toEqual([{ campaignId: C1, distance: 1 }]);
    expect(result.modification.meanDistance).toBe(1);
    expect(result.modification.zeroDistanceCount).toBe(0);
    expect(prisma.campaignRevision.findMany).toHaveBeenCalledTimes(2);
  });

  it('treats an approval of the first draft as zero-distance', async () => {
    const plan = { goal: { objective: 'a' } };
    const { service } = makeService({
      approvals: [approval({ id: 'a1', revisionId: 'rev-1', state: 'APPROVED' })],
      revisions: [{ id: 'rev-1', campaignId: C1, revisionNo: 1, plan }],
    });
    const result = await service.campaignMetrics({ from: FROM, to: TO, now: NOW });
    expect(result.modification.zeroDistanceCount).toBe(1);
    expect(result.modification.meanDistance).toBe(0);
  });

  it('buckets replan rounds per campaign into 0/1/2/3+', async () => {
    const traces = [
      ...Array.from({ length: 1 }, () => ({ campaignId: C1, costActualMicros: null })),
      ...Array.from({ length: 3 }, () => ({ campaignId: C2, costActualMicros: null })),
      { campaignId: null, costActualMicros: null },
    ];
    const { service } = makeService({
      approvals: [
        approval({ id: 'a1', revisionId: 'rev-1', state: 'APPROVED', revision: { campaignId: C1 } }),
        approval({ id: 'a2', revisionId: 'rev-2', state: 'DECLINED', revision: { campaignId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } }),
      ],
      revisions: [{ id: 'rev-1', campaignId: C1, revisionNo: 1, plan: {} }],
      traces,
    });
    const result = await service.campaignMetrics({ from: FROM, to: TO, now: NOW });
    expect(result.replans.perCampaign).toEqual([
      { campaignId: C1, rounds: 1 },
      { campaignId: C2, rounds: 3 },
      { campaignId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', rounds: 0 },
    ]);
    expect(result.replans.distribution).toEqual({ rounds0: 1, rounds1: 1, rounds2: 0, rounds3plus: 1 });
  });

  it('prefers trace cost fields when present', async () => {
    const { service, engine } = makeService({
      approvals: [approval({ id: 'a1', state: 'APPROVED' }), approval({ id: 'a2', revisionId: 'rev-2', state: 'APPROVED' })],
      revisions: [{ id: 'rev-1', campaignId: C1, revisionNo: 1, plan: {} }],
      traces: [{ campaignId: C1, costActualMicros: 1_000_000n }, { campaignId: C1, costActualMicros: 500_000n }],
    });
    const result = await service.campaignMetrics({ from: FROM, to: TO, now: NOW });
    expect(result.cost).toMatchObject({ status: 'ok', source: 'campaign_decision_trace', totalCostMicros: 1_500_000 });
    expect(result.cost.costPerApprovedPlanMicros).toBe(750_000);
    expect(engine.query).not.toHaveBeenCalled();
  });

  it('falls back to the engine usage ledger and converts USD to micros', async () => {
    const { service } = makeService({
      approvals: [approval({ id: 'a1', state: 'APPROVED' }), approval({ id: 'a2', revisionId: 'rev-2', state: 'APPROVED' })],
      revisions: [{ id: 'rev-1', campaignId: C1, revisionNo: 1, plan: {} }],
      engineQuery: async () => [{ campaign_id: C1, cost_usd: 0.5 }],
    });
    const result = await service.campaignMetrics({ from: FROM, to: TO, now: NOW });
    expect(result.cost).toMatchObject({ status: 'ok', source: 'usage_ledger', totalCostMicros: 500_000 });
    expect(result.cost.costPerApprovedPlanMicros).toBe(250_000);
  });

  it('reports cost as pending (never zero) when no attribution exists or the engine DB is unavailable', async () => {
    const empty = makeService({
      approvals: [approval({ id: 'a1', state: 'APPROVED' })],
      revisions: [{ id: 'rev-1', campaignId: C1, revisionNo: 1, plan: {} }],
      engineQuery: async () => [],
    });
    const pending = await empty.service.campaignMetrics({ from: FROM, to: TO, now: NOW });
    expect(pending.cost.status).toBe('pending');
    expect(pending.cost.totalCostMicros).toBeNull();
    expect(pending.cost.reason).toContain('M2.2-1');

    const failing = makeService({
      approvals: [approval({ id: 'a1', state: 'APPROVED' })],
      revisions: [{ id: 'rev-1', campaignId: C1, revisionNo: 1, plan: {} }],
      engineQuery: async () => {
        throw new Error('OPS_NOT_CONFIGURED');
      },
    });
    const unavailable = await failing.service.campaignMetrics({ from: FROM, to: TO, now: NOW });
    expect(unavailable.cost.status).toBe('pending');
    expect(unavailable.cost.reason).toContain('引擎运营库不可用');
  });
});

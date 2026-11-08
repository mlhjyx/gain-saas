import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../shared/prisma.service.js';
import type { OpsDatabase } from './ops-database.service.js';
import { OpsAttributionService } from './ops-attribution.service.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN = '22222222-2222-4222-8222-222222222222';

function viewRow(overrides: Record<string, unknown> = {}) {
  return {
    campaign_id: CAMPAIGN,
    campaign_name: '德国泵类分销商 Q4',
    campaign_status: 'ACTIVE',
    exec_cost_micros: 1_500_000n,
    plan_cost_micros: 0n,
    spend_total_micros: 1_500_000n,
    qgo_count: 2n,
    sao_count: 2n,
    positive_count: 1n,
    reply_count: 1n,
    negative_count: 0n,
    cost_per_positive_micros: 1_500_000n,
    pipeline_per_dollar: null,
    ...overrides,
  };
}

function makeService(options: {
  viewRows?: unknown[];
  ledgerRows?: unknown[];
  engineRows?: Array<{ campaign_id: string | null; plan_engine_micros: bigint }>;
} = {}) {
  const queryRaw = vi.fn(async (sql: unknown) => {
    const text = String((sql as { strings?: string[] })?.strings?.join?.(' ') ?? sql);
    if (text.includes('v_campaign_attribution')) return options.viewRows ?? [viewRow()];
    if (text.includes('exec_ledger_micros')) {
      return options.ledgerRows ?? [{ campaign_id: CAMPAIGN, exec_ledger_micros: 1_500_000n }];
    }
    return [];
  });
  const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
  const clientQuery = vi.fn(async () => ({ rows: options.engineRows ?? [] }));
  const database = {
    db: {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (client: { query: typeof clientQuery }) => unknown) =>
        fn({ query: clientQuery }),
      ),
    },
  } as unknown as OpsDatabase;
  return { service: new OpsAttributionService(database, prisma), queryRaw, clientQuery };
}

describe('OpsAttributionService（M2 步 12-1 归因闭环）', () => {
  it('把视图行映射为漏斗与 campaign 明细，并给出对账徽标（一致）', async () => {
    const { service } = makeService();

    const result = await service.attribution(WORKSPACE);

    expect(result.funnel).toEqual({
      campaigns: 1,
      spendTotalMicros: 1_500_000,
      execCostMicros: 1_500_000,
      planCostMicros: 0,
      qgoCount: 2,
      saoCount: 2,
      positiveCount: 1,
      replyCount: 1,
      negativeCount: 0,
    });
    expect(result.campaigns[0]).toMatchObject({
      campaignId: CAMPAIGN,
      execCostMicros: 1_500_000,
      costPerPositiveMicros: 1_500_000,
      pipelinePerDollar: null,
    });
    expect(result.reconciliation.balanced).toBe(true);
    expect(result.reconciliation.rows).toEqual([
      expect.objectContaining({
        campaignId: CAMPAIGN,
        execViewMicros: 1_500_000,
        execLedgerMicros: 1_500_000,
        planViewMicros: 0,
        planEngineMicros: 0,
        diffMicros: 0,
      }),
    ]);
  });

  it('引擎 plan 归集按真实 meta 形状读取（task + runId 第三段 = campaignId）', async () => {
    const { service, clientQuery } = makeService({ engineRows: [] });

    await service.attribution(WORKSPACE);

    const call = clientQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(call[0]).toContain("split_part(meta ->> $2, ':', 3)");
    expect(call[1]).toEqual(['task', 'runId', 'campaign.plan', 'campaign']);
  });

  it('引擎 usage_ledger 出现 campaign.plan 成本而视图未计入 → 红（差异为负）', async () => {
    const { service } = makeService({
      engineRows: [{ campaign_id: CAMPAIGN, plan_engine_micros: 500_000n }],
    });

    const result = await service.attribution(WORKSPACE);

    expect(result.reconciliation.balanced).toBe(false);
    expect(result.reconciliation.rows[0]).toMatchObject({
      campaignId: CAMPAIGN,
      planEngineMicros: 500_000,
      diffMicros: -500_000,
    });
  });

  it('exec 侧视图与原始表重算不一致 → 红（抓视图/定义漂移）', async () => {
    const { service } = makeService({
      ledgerRows: [{ campaign_id: CAMPAIGN, exec_ledger_micros: 1_400_000n }],
    });

    const result = await service.attribution(WORKSPACE);

    expect(result.reconciliation.balanced).toBe(false);
    expect(result.reconciliation.rows[0]).toMatchObject({
      execViewMicros: 1_500_000,
      execLedgerMicros: 1_400_000,
      diffMicros: 100_000,
    });
  });

  it('引擎侧未知 campaign 的计划成本不吞掉，以合成行暴露', async () => {
    const { service } = makeService({
      engineRows: [
        { campaign_id: '33333333-3333-4333-8333-333333333333', plan_engine_micros: 42n },
      ],
    });

    const result = await service.attribution(WORKSPACE);

    expect(result.reconciliation.balanced).toBe(false);
    const ghost = result.reconciliation.rows.find((row) => row.campaignName.includes('引擎侧未知'));
    expect(ghost).toMatchObject({ planEngineMicros: 42, diffMicros: -42 });
  });

  it('workspace id 非 UUID 直接 400，不触库', async () => {
    const { service, queryRaw } = makeService();
    await expect(service.attribution('not-a-uuid')).rejects.toBeInstanceOf(BadRequestException);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

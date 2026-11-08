import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpsDatabase } from './ops-database.service.js';
import { OpsAttributionService } from './ops-attribution.service.js';
import {
  dockerAvailable,
  startDisposablePostgres,
  type DisposablePostgres,
} from './attribution-test-pg.js';

/**
 * M2 步 12-1 验收核心（真库）：一次性 PostgreSQL 容器 + 全量迁移，
 * 断言 v_campaign_attribution / v_outcome_chain 的口径与「一分不差」对账；
 * 含故意造差变红样例（引擎侧出现视图未计入的 campaign.plan 成本）。
 *
 * 供应器见 attribution-test-pg.ts（digest 钉住的镜像；CI 无 docker 即失败）。
 */
const available = dockerAvailable();
if (!available) {
  // CI 必须真跑这条验收（真库一致性 + 造差变红）；docker 缺失视为失败而不是静默通过。
  if (process.env.CI === 'true') {
    throw new Error('[ops-attribution.pg] CI 需要 docker 运行真库一致性测试，但 docker 不可用');
  }
  console.warn('[ops-attribution.pg] docker 不可用，跳过真库一致性测试');
}

describe.skipIf(!available)('归因视图与台账对账（disposable PostgreSQL）', () => {
  let pg: DisposablePostgres;
  let prisma: PrismaClient;
  let service: OpsAttributionService;
  let enginePlanRows: Array<{ campaign_id: string | null; plan_engine_micros: bigint }>;

  const ids = {
    workspace: randomUUID(),
    user: randomUUID(),
    campaign: randomUUID(),
    campaignLate: randomUUID(),
    icp: randomUUID(),
    icpLate: randomUUID(),
    plan: randomUUID(),
    planLate: randomUUID(),
    run: randomUUID(),
    runLate: randomUUID(),
    event: randomUUID(),
    lateEvent: randomUUID(),
    qgoPositive: randomUUID(),
    qgoReply: randomUUID(),
    qgoOrganic: randomUUID(),
    saoPositive: randomUUID(),
    saoReply: randomUUID(),
    saoOrganic: randomUUID(),
  };
  const issuedAt = new Date('2026-11-08T00:00:00Z');

  beforeAll(async () => {
    pg = startDisposablePostgres();
    prisma = new PrismaClient({ datasourceUrl: pg.databaseUrl });
    await seed();

    enginePlanRows = [];
    const database = {
      db: {
        withWorkspace: async (
          _workspaceId: string,
          fn: (client: {
            query: () => Promise<{ rows: typeof enginePlanRows }>;
          }) => unknown,
        ) => fn({ query: async () => ({ rows: enginePlanRows }) }),
      },
    } as unknown as OpsDatabase;
    service = new OpsAttributionService(database, prisma as never);
  }, 900_000);

  afterAll(async () => {
    await prisma?.$disconnect().catch(() => undefined);
    pg?.stop();
  }, 120_000);

  async function seed(): Promise<void> {
    await prisma.workspace.create({
      data: { id: ids.workspace, name: 'attribution probe' },
    });
    await prisma.campaign.createMany({
      data: [
        {
          id: ids.campaign,
          workspaceId: ids.workspace,
          name: '德国泵类分销商 Q4',
          objective: 'probe',
          status: 'ACTIVE',
          createdBy: 'ops',
          updatedBy: 'ops',
        },
        {
          id: ids.campaignLate,
          workspaceId: ids.workspace,
          name: '晚授权战役',
          objective: 'probe',
          status: 'ACTIVE',
          createdBy: 'ops',
          updatedBy: 'ops',
        },
      ],
    });
    await prisma.campaignExecutionAuthorization.createMany({
      data: [
        {
          id: randomUUID(),
          workspaceId: ids.workspace,
          campaignId: ids.campaign,
          revisionId: randomUUID(),
          planHash: 'a'.repeat(64),
          scope: { actions: [{ type: 'discovery', icpIds: [ids.icp] }] } as never,
          token: 'token-1',
          state: 'ISSUED',
          maxUses: 1,
          uses: 0,
          issuedAt,
          expiresAt: new Date('2026-11-09T00:00:00Z'),
        },
        {
          id: randomUUID(),
          workspaceId: ids.workspace,
          campaignId: ids.campaignLate,
          revisionId: randomUUID(),
          planHash: 'b'.repeat(64),
          scope: { actions: [{ type: 'discovery', icpIds: [ids.icpLate] }] } as never,
          token: 'token-2',
          state: 'ISSUED',
          maxUses: 1,
          uses: 0,
          issuedAt,
          expiresAt: new Date('2026-11-09T00:00:00Z'),
        },
      ],
    });
    await prisma.discoveryRunLink.createMany({
      data: [
        {
          runId: ids.run,
          workspaceId: ids.workspace,
          planId: ids.plan,
          icpId: ids.icp,
          createdAt: new Date('2026-11-08T01:00:00Z'),
        },
        // 授权前发起的 run：不计入晚授权战役（issued_at 闸门）。
        {
          runId: ids.runLate,
          workspaceId: ids.workspace,
          planId: ids.planLate,
          icpId: ids.icpLate,
          createdAt: new Date('2026-11-07T22:00:00Z'),
        },
      ],
    });
    await prisma.eventInbox.createMany({
      data: [
        {
          eventId: ids.event,
          workspaceId: ids.workspace,
          type: 'DiscoveryRunCompleted',
          payload: { planId: ids.plan, status: 'DONE', cost: 1.5 } as never,
          occurredAt: new Date('2026-11-08T02:00:00Z'),
        },
        {
          eventId: ids.lateEvent,
          workspaceId: ids.workspace,
          type: 'DiscoveryRunCompleted',
          payload: { planId: ids.planLate, status: 'DONE', cost: 9 } as never,
          occurredAt: new Date('2026-11-07T23:00:00Z'),
        },
      ],
    });
    await prisma.costLedger.createMany({
      data: [
        {
          workspaceId: ids.workspace,
          sourceEventId: ids.event,
          amountMicros: 1_500_000,
          occurredAt: new Date('2026-11-08T02:00:00Z'),
        },
        {
          workspaceId: ids.workspace,
          sourceEventId: ids.lateEvent,
          amountMicros: 9_000_000,
          occurredAt: new Date('2026-11-07T23:00:00Z'),
        },
      ],
    });
    await prisma.qgo.createMany({
      data: [
        {
          id: ids.qgoPositive,
          workspaceId: ids.workspace,
          leadRef: randomUUID(),
          canonicalCompanyRef: randomUUID(),
          campaignId: ids.campaign,
          title: 'Acme Pumps',
          evidence: [{ kind: 'fit', verdict: 'match' }] as never,
          nextStep: '约会议',
          state: 'CONVERTED',
          createdBy: ids.user,
        },
        {
          id: ids.qgoReply,
          workspaceId: ids.workspace,
          leadRef: randomUUID(),
          canonicalCompanyRef: randomUUID(),
          campaignId: ids.campaign,
          title: 'Beta Valves',
          evidence: [{ kind: 'fit', verdict: 'weak' }] as never,
          nextStep: '跟进回复',
          state: 'CONVERTED',
          createdBy: ids.user,
        },
        {
          id: ids.qgoOrganic,
          workspaceId: ids.workspace,
          leadRef: randomUUID(),
          canonicalCompanyRef: randomUUID(),
          campaignId: null,
          title: 'Organic Co',
          evidence: [{ kind: 'fit', verdict: 'match' }] as never,
          nextStep: '自然流入',
          state: 'CONVERTED',
          createdBy: ids.user,
        },
      ],
    });
    await prisma.sao.createMany({
      data: [
        {
          id: ids.saoPositive,
          workspaceId: ids.workspace,
          qgoId: ids.qgoPositive,
          state: 'ACCEPTED',
          decidedBy: ids.user,
          decidedAt: new Date('2026-11-08T03:00:00Z'),
        },
        {
          id: ids.saoReply,
          workspaceId: ids.workspace,
          qgoId: ids.qgoReply,
          state: 'ACCEPTED',
          decidedBy: ids.user,
          decidedAt: new Date('2026-11-08T03:00:00Z'),
        },
        {
          id: ids.saoOrganic,
          workspaceId: ids.workspace,
          qgoId: ids.qgoOrganic,
          state: 'ACCEPTED',
          decidedBy: ids.user,
          decidedAt: new Date('2026-11-08T03:00:00Z'),
        },
      ],
    });
    await prisma.opportunityOutcome.createMany({
      data: [
        {
          id: randomUUID(),
          workspaceId: ids.workspace,
          saoId: ids.saoPositive,
          outcome: 'MEETING_BOOKED',
          occurredAt: new Date('2026-11-08T04:00:00Z'),
          source: 'MANUAL',
          createdBy: ids.user,
        },
        {
          id: randomUUID(),
          workspaceId: ids.workspace,
          saoId: ids.saoReply,
          outcome: 'REPLIED',
          occurredAt: new Date('2026-11-08T04:10:00Z'),
          source: 'MANUAL',
          createdBy: ids.user,
        },
        {
          id: randomUUID(),
          workspaceId: ids.workspace,
          saoId: ids.saoReply,
          outcome: 'LOST',
          occurredAt: new Date('2026-11-08T05:00:00Z'),
          source: 'MANUAL',
          createdBy: ids.user,
        },
        {
          id: randomUUID(),
          workspaceId: ids.workspace,
          saoId: ids.saoOrganic,
          outcome: 'WON',
          occurredAt: new Date('2026-11-08T05:30:00Z'),
          source: 'MANUAL',
          createdBy: ids.user,
        },
      ],
    });
  }

  it('视图口径：exec 成本一分不差、漏斗计数与 positive/弱信号/负向分母分离、organic 不入 campaign', async () => {
    const result = await service.attribution(ids.workspace);

    const campaign = result.campaigns.find((row) => row.campaignId === ids.campaign);
    expect(campaign).toMatchObject({
      execCostMicros: 1_500_000,
      planCostMicros: 0,
      spendTotalMicros: 1_500_000,
      qgoCount: 2,
      saoCount: 2,
      positiveCount: 1,
      replyCount: 1,
      negativeCount: 1,
      costPerPositiveMicros: 1_500_000,
      pipelinePerDollar: null,
    });
    // 晚授权战役：授权前发起的 run 不计入（issued_at 闸门），exec=0。
    const late = result.campaigns.find((row) => row.campaignId === ids.campaignLate);
    expect(late?.execCostMicros).toBe(0);
    // organic 的 WON 不出现在任何 campaign 行里。
    expect(result.funnel.positiveCount).toBe(1);
    // 对账：无引擎 plan 成本 → 全 0 差异。
    expect(result.reconciliation.balanced).toBe(true);
    for (const row of result.reconciliation.rows) expect(row.diffMicros).toBe(0);
  }, 60_000);

  it('v_outcome_chain：CAMPAIGN / ORGANIC 归因类型与链成本快照', async () => {
    const rows = await prisma.$queryRaw<
      Array<{
        outcome_type: string;
        attribution_type: string;
        campaign_id: string | null;
        chain_exec_cost_micros: bigint;
      }>
    >`SELECT outcome_type, attribution_type, campaign_id, chain_exec_cost_micros FROM v_outcome_chain WHERE workspace_id = ${ids.workspace}::uuid`;
    const byType = new Map(rows.map((row) => [row.outcome_type, row]));
    expect(byType.get('MEETING_BOOKED')).toMatchObject({
      attribution_type: 'CAMPAIGN',
      campaign_id: ids.campaign,
      chain_exec_cost_micros: 1_500_000n,
    });
    expect(byType.get('WON')).toMatchObject({
      attribution_type: 'ORGANIC',
      campaign_id: null,
      chain_exec_cost_micros: 0n,
    });
  }, 60_000);

  it('故意造差变红：引擎侧出现 campaign.plan 成本而视图未计入 → 对账红（差异精确）', async () => {
    enginePlanRows = [{ campaign_id: ids.campaign, plan_engine_micros: 500_000n }];
    try {
      const result = await service.attribution(ids.workspace);
      expect(result.reconciliation.balanced).toBe(false);
      const row = result.reconciliation.rows.find((item) => item.campaignId === ids.campaign);
      expect(row).toMatchObject({ planViewMicros: 0, planEngineMicros: 500_000, diffMicros: -500_000 });
    } finally {
      enginePlanRows = [];
    }
  }, 60_000);
});

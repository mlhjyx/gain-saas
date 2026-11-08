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

    // 引擎侧真实形状：在本一次性库里建同名 usage_ledger 表，让对账 SQL 真被执行
    //（不是预置行 mock），覆盖 task/runId 解析逻辑。
    await prisma.$executeRawUnsafe(`CREATE TABLE usage_ledger (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL,
      resource_type text,
      quantity double precision,
      cost_usd double precision,
      ref_type text,
      ref_id text,
      meta jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    const database = {
      db: {
        withWorkspace: async (
          _workspaceId: string,
          fn: (client: {
            query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
          }) => unknown,
        ) =>
          fn({
            query: async (sql, params = []) => ({
              rows: (await prisma.$queryRawUnsafe(sql, ...params)) as unknown[],
            }),
          }),
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

  it('引擎真实形状行（meta.task + meta.runId）：归集一分不差，故意造差 → 红', async () => {
    // 2026-11-08 global_dev 实测形状：{"task":"campaign.plan","runId":"campaign.plan:campaign:<id>:<hash>"}。
    await prisma.$executeRawUnsafe(
      `INSERT INTO usage_ledger (id, workspace_id, resource_type, quantity, cost_usd, ref_type, meta)
       VALUES ($1::uuid, $2::uuid, 'ai_tokens', 1, 0.01, 'ai_trace', $3::jsonb)`,
      randomUUID(),
      ids.workspace,
      JSON.stringify({
        task: 'campaign.plan',
        model: 'deepseek-flash',
        runId: `campaign.plan:campaign:${ids.campaign}:deadbeef`,
        costSource: 'token_estimate',
      }),
    );
    // 诱饵：runId 第二段不是 campaign（形状不符）的行不得参与归集。
    await prisma.$executeRawUnsafe(
      `INSERT INTO usage_ledger (id, workspace_id, resource_type, cost_usd, meta)
       VALUES ($1::uuid, $2::uuid, 'ai_tokens', 5, $3::jsonb)`,
      randomUUID(),
      ids.workspace,
      JSON.stringify({
        task: 'campaign.plan',
        runId: `campaign.plan:run:${randomUUID()}`,
      }),
    );
    try {
      const result = await service.attribution(ids.workspace);
      expect(result.reconciliation.balanced).toBe(false);
      const row = result.reconciliation.rows.find((item) => item.campaignId === ids.campaign);
      expect(row).toMatchObject({
        planViewMicros: 0,
        planEngineMicros: 10_000,
        diffMicros: -10_000,
      });
    } finally {
      await prisma.$executeRawUnsafe(
        `DELETE FROM usage_ledger WHERE workspace_id = $1::uuid`,
        ids.workspace,
      );
    }
  }, 60_000);
});

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CampaignService } from '../campaign/campaign.service.js';
import { QgoService } from '../qgo/qgo.service.js';
import type { OpsDatabase } from './ops-database.service.js';
import { OpsAttributionService } from './ops-attribution.service.js';
import {
  dockerAvailable,
  startDisposablePostgres,
  type DisposablePostgres,
} from './attribution-test-pg.js';

/**
 * M2 步 12-3 联调预演（12-1 合并后的端到端排练）：
 * 用**真实 Campaign/QGO 服务**走 战役→审批→授权→商机→接受→outcome，
 * 引擎侧（run 链接/事件/花费）按真实形状直插模拟；最后由归因服务断言
 * 视图口径与台账对账。等步 11（触达/回复）落地后，只需把 REPLIED 的来源
 * 从人工换成系统回写即可复用本排练。
 *
 * 真库：一次性 PostgreSQL（digest 钉住的镜像）+ 全量迁移；CI 必须真跑。
 */
const available = dockerAvailable();
if (!available) {
  if (process.env.CI === 'true') {
    throw new Error('[ops-attribution.e2e] CI 需要 docker 运行 12-3 联调预演，但 docker 不可用');
  }
  console.warn('[ops-attribution.e2e] docker 不可用，跳过 12-3 联调预演');
}

describe.skipIf(!available)('12-3 联调预演：战役→商机→outcome→归因（真实服务 + 真库）', () => {
  let pg: DisposablePostgres;
  let prisma: PrismaClient;
  let campaigns: CampaignService;
  let qgos: QgoService;
  let attribution: OpsAttributionService;
  const enginePlanRows: Array<{ campaign_id: string | null; plan_engine_micros: bigint }> = [];

  const ids = {
    workspace: randomUUID(),
    admin: randomUUID(),
    icp: randomUUID(),
    plan: randomUUID(),
    run: randomUUID(),
    event: randomUUID(),
  };
  const tenant = { workspaceId: ids.workspace, userId: ids.admin } as never;

  function planFixture() {
    return {
      schemaVersion: 'campaign-plan/v0',
      goal: { objective: '联调预演：德国泵类分销商' },
      audience: { icpIds: [ids.icp], sizeCap: 50 },
      motions: [{ type: 'discovery', icpIds: [ids.icp] }],
      budget: { currency: 'USD' },
      approvalPolicy: { required: true },
      decisionPolicy: { maxReplans: 0 },
    };
  }

  beforeAll(async () => {
    pg = startDisposablePostgres();
    prisma = new PrismaClient({ datasourceUrl: pg.databaseUrl });
    await prisma.workspace.create({ data: { id: ids.workspace, name: '12-3 rehearsal' } });

    const audit = { record: async () => undefined } as never;
    const signer = { sign: async () => 'stub-authorization-token' } as never;
    const config = {
      CAMPAIGN_APPROVAL_TTL_HOURS: 72,
      CAMPAIGN_AUTHZ_TTL_MINUTES: 30,
      CAMPAIGN_AUDIENCE_SIZE_CAP_MAX: 1000,
    } as never;
    campaigns = new CampaignService(prisma as never, audit, signer, { onApprovalDeclined: async () => undefined } as never, config);
    qgos = new QgoService(prisma as never, audit);

    const database = {
      db: {
        withWorkspace: async (
          _workspaceId: string,
          fn: (client: { query: () => Promise<{ rows: typeof enginePlanRows }> }) => unknown,
        ) => fn({ query: async () => ({ rows: enginePlanRows }) }),
      },
    } as unknown as OpsDatabase;
    attribution = new OpsAttributionService(database, prisma as never);
  }, 900_000);

  afterAll(async () => {
    await prisma?.$disconnect().catch(() => undefined);
    pg?.stop();
  }, 120_000);

  async function promoteAndAccept(options: { campaignId?: string; outcomes: Array<Record<string, unknown>> }) {
    // 真实链路前置：线索先被 LeadQualified 接受（影子行），promote 才放行。
    const leadRef = randomUUID();
    const canonicalCompanyRef = randomUUID();
    await prisma.qualifiedLead.create({
      data: {
        eventId: randomUUID(),
        workspaceId: ids.workspace,
        leadId: leadRef,
        icpId: ids.icp,
        snapshot: {
          company_ref: { canonical_company_id: canonicalCompanyRef, name: `Buyer ${leadRef.slice(0, 8)}` },
          icp_id: ids.icp,
          scores: { total: 80 },
        } as never,
      },
    });
    const promoted = (await qgos.promote(tenant, {
      leadRef,
      evidence: [
        { type: 'customer_reply', url: 'https://buyer.example/reply', support: '询价泵型号' },
      ],
      nextStep: '约会议',
      ...(options.campaignId ? { campaignId: options.campaignId } : {}),
    })) as { qgo: { id: string } };
    const qgoId = promoted.qgo.id;
    await qgos.accept(tenant, qgoId);
    const sao = await prisma.sao.findFirstOrThrow({
      where: { workspaceId: ids.workspace, qgoId },
      select: { id: true },
    });
    for (const outcome of options.outcomes) {
      await qgos.addOutcome(tenant, sao.id, outcome as never);
    }
    return { qgoId, saoId: sao.id };
  }

  it('走通真实服务链路后，归因视图与台账对账一致（含 organic 隔离与弱信号分母）', async () => {
    // 1) 战役 → revision → 提交 → 审批通过（签发 execution authorization）。
    const campaign = await campaigns.createCampaign(tenant, {
      name: '联调预演战役',
      objective: '德国泵类分销商',
    });
    const campaignId = (campaign as { id: string }).id;
    const revision = await campaigns.createRevision(tenant, campaignId, planFixture());
    const submitted = await campaigns.submitRevision(tenant, campaignId, revision.id);
    await campaigns.decideApproval(tenant, campaignId, submitted.approval.id, {
      decision: 'approve',
    });
    const authorization = await prisma.campaignExecutionAuthorization.findFirstOrThrow({
      where: { workspaceId: ids.workspace, campaignId },
      select: { issuedAt: true, scope: true, state: true },
    });
    expect(authorization.state).toBe('ISSUED');
    expect(JSON.stringify(authorization.scope)).toContain(ids.icp);

    // 2) 引擎侧真实形状：授权后发起 run → 完成事件（planId）→ 花费落账 1.5 美元。
    await prisma.discoveryRunLink.create({
      data: {
        runId: ids.run,
        workspaceId: ids.workspace,
        planId: ids.plan,
        icpId: ids.icp,
        createdAt: new Date(authorization.issuedAt.getTime() + 60_000),
      },
    });
    await prisma.eventInbox.create({
      data: {
        eventId: ids.event,
        workspaceId: ids.workspace,
        type: 'DiscoveryRunCompleted',
        payload: { planId: ids.plan, status: 'DONE', cost: 1.5 } as never,
        occurredAt: new Date(),
      },
    });
    await prisma.costLedger.create({
      data: {
        workspaceId: ids.workspace,
        sourceEventId: ids.event,
        amountMicros: 1_500_000,
        occurredAt: new Date(),
      },
    });

    // 3) 商机链路（真实服务）：两条战役商机（会议 positive / 回复+LOST 弱信号+负向）+ 一条 organic 赢单。
    await promoteAndAccept({ campaignId, outcomes: [{ outcome: 'MEETING_BOOKED' }] });
    await promoteAndAccept({
      campaignId,
      outcomes: [{ outcome: 'REPLIED' }, { outcome: 'LOST' }],
    });
    await promoteAndAccept({ outcomes: [{ outcome: 'WON' }] });

    // 4) 归因：漏斗/明细/对账。
    const result = await attribution.attribution(ids.workspace);
    const row = result.campaigns.find((item) => item.campaignId === campaignId);
    expect(row).toMatchObject({
      execCostMicros: 1_500_000,
      planCostMicros: 0,
      spendTotalMicros: 1_500_000,
      qgoCount: 2,
      saoCount: 2,
      positiveCount: 1,
      replyCount: 1,
      negativeCount: 1,
      costPerPositiveMicros: 1_500_000,
    });
    // organic 赢单不进战役分母；漏斗的 positive 只按战役行汇总。
    expect(result.funnel.positiveCount).toBe(1);
    expect(result.reconciliation.balanced).toBe(true);
    for (const item of result.reconciliation.rows) expect(item.diffMicros).toBe(0);
  }, 120_000);

  it('链视图给出 CAMPAIGN/ORGANIC 归因类型与链成本快照', async () => {
    const rows = await prisma.$queryRaw<
      Array<{ outcome_type: string; attribution_type: string; chain_exec_cost_micros: bigint }>
    >`SELECT outcome_type, attribution_type, chain_exec_cost_micros FROM v_outcome_chain WHERE workspace_id = ${ids.workspace}::uuid`;
    const byType = new Map(rows.map((row) => [row.outcome_type, row]));
    expect(byType.get('MEETING_BOOKED')).toMatchObject({
      attribution_type: 'CAMPAIGN',
      chain_exec_cost_micros: 1_500_000n,
    });
    expect(byType.get('WON')).toMatchObject({
      attribution_type: 'ORGANIC',
      chain_exec_cost_micros: 0n,
    });
  }, 60_000);
});

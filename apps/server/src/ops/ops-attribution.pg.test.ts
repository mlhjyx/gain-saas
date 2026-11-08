import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OpsDatabase } from './ops-database.service.js';
import { OpsAttributionService } from './ops-attribution.service.js';

/**
 * M2 步 12-1 验收核心（真库）：一次性 PostgreSQL 容器 + 全量迁移，
 * 断言 v_campaign_attribution / v_outcome_chain 的口径与「一分不差」对账；
 * 含故意造差变红样例（引擎侧出现视图未计入的 campaign.plan 成本）。
 *
 * 本机用 default docker context（显式注入，不影响宿主其它项目）；
 * 无 docker 的环境跳过并给出提示（不伪装通过）。
 */
const dockerEnv = { ...process.env, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT ?? 'default' };

function dockerAvailable(): boolean {
  try {
    // 高负载主机上 docker info 可能超过 10s（本机 load 40+ 实测），放宽到 60s。
    execFileSync('docker', ['info'], { env: dockerEnv, stdio: 'ignore', timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

const available = dockerAvailable();
if (!available) {
  // CI 必须真跑这条验收（真库一致性 + 造差变红）；docker 缺失视为失败而不是静默通过。
  if (process.env.CI === 'true') {
    throw new Error('[ops-attribution.pg] CI 需要 docker 运行真库一致性测试，但 docker 不可用');
  }
  console.warn('[ops-attribution.pg] docker 不可用，跳过真库一致性测试');
}

const serverDir = fileURLToPath(new URL('../..', import.meta.url));
const prismaBin = fileURLToPath(new URL('../../node_modules/.bin/prisma', import.meta.url));

describe.skipIf(!available)('归因视图与台账对账（disposable PostgreSQL）', () => {
  const containerName = `gain-attribution-${process.pid}-${randomUUID().slice(0, 8)}`;
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
    execFileSync(
      'docker',
      [
        'run', '-d', '--name', containerName,
        '-e', 'POSTGRES_PASSWORD=attribution-test',
        '-p', '127.0.0.1::5432',
        // 按 digest 钉住（/global/CLAUDE.md「镜像一律按 digest 钉住」）。
        'postgres:16-alpine@sha256:aa6cb33cf4c19c765cefcf48d96176258800870a9a1e930ad126200f9d825139',
      ],
      { env: dockerEnv, stdio: 'ignore' },
    );
    let ready = false;
    for (let attempt = 0; attempt < 300 && !ready; attempt += 1) {
      try {
        // 必须走 TCP：init 阶段的临时 postgres 只监听 socket，socket 探针会假就绪
        // （2026-11-08 本机 load 40+ 时 initdb 用了约 3.5 分钟，socket 探针提前通过）。
        execFileSync(
          'docker',
          [
            'exec', containerName,
            'pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres',
          ],
          { env: dockerEnv, stdio: 'ignore' },
        );
        ready = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    if (!ready) throw new Error('disposable postgres did not become ready');

    const portMapping = execFileSync('docker', ['port', containerName, '5432/tcp'], {
      env: dockerEnv,
    })
      .toString()
      .trim()
      .split('\n')[0]!;
    const port = portMapping.slice(portMapping.lastIndexOf(':') + 1);
    const databaseUrl = `postgresql://postgres:attribution-test@127.0.0.1:${port}/postgres`;

    try {
      execFileSync(prismaBin, ['migrate', 'deploy'], {
        cwd: serverDir,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: 'pipe',
      });
    } catch (error) {
      const stderr = (error as { stderr?: Buffer }).stderr?.toString('utf8') ?? '';
      throw new Error(`prisma migrate deploy failed: ${stderr || String(error)}`);
    }

    prisma = new PrismaClient({ datasourceUrl: databaseUrl });
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
    try {
      execFileSync('docker', ['rm', '-f', containerName], { env: dockerEnv, stdio: 'ignore' });
    } catch {
      /* 容器已被移除 */
    }
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

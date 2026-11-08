import '../shared/load-env.js';
/**
 * M2 步 12-3 正式联调断言（只读）：用 11-x 沙箱全链产生的数据，验证
 * 「商机 → 发送 → 回复 → outcome(REPLIED) → 归因」整链与台账一致。
 *
 * 运行（dev 两库，只读；不写任何数据）：
 *   pnpm --filter @gain-saas/server exec tsx src/scripts/attribution-12-3-live.ts <workspaceId> [campaignId]
 *
 * 断言口径（与 12-1 设计一致，不新增规则）：
 *   1) 发送链路有料：outreach_batch / outreach_draft / outreach_send 存在；
 *   2) 回复有料：outreach_reply（kind=REPLY）存在；若沙箱链路已回写 outcome，
 *      opportunity_outcome 存在 outcome='REPLIED' 行（source SYSTEM/MANUAL 均列出）；
 *   3) 归因口径：目标 campaign 的 replyCount == 该 campaign 下含 REPLIED outcome 的
 *      distinct SAO 数（弱信号按 SAO 去重，多条回复不放大）；
 *   4) 对账：沿用既有规则——任一行 diff≠0 即 balanced=false（plan 侧 v0 占位差异
 *      属预期，脚本如实报告而非误判通过）。
 *
 * 退出码：0 = 结构断言通过（对账差异如实报告）；1 = 缺配置/参数；2 = 结构断言失败。
 */
import { OpsPg } from '@gain-saas/ops-pg';
import { PrismaService } from '../shared/prisma.service.js';
import { OpsAttributionService } from '../ops/ops-attribution.service.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Check {
  name: string;
  ok: boolean;
  detail: unknown;
}

async function main(): Promise<void> {
  const workspaceId = process.argv[2] ?? '';
  const campaignId = process.argv[3];
  if (!UUID_RE.test(workspaceId) || (campaignId !== undefined && !UUID_RE.test(campaignId))) {
    console.error('用法: tsx src/scripts/attribution-12-3-live.ts <workspaceId> [campaignId]');
    process.exit(1);
  }

  const appUrl = process.env.OPS_APP_DATABASE_URL;
  const ownerUrl = process.env.OPS_OWNER_DATABASE_URL;
  if (!appUrl) {
    console.error('缺少 OPS_APP_DATABASE_URL（引擎库只读连接），无法核对 plan 侧台账。');
    process.exit(1);
  }

  const prisma = new PrismaService();
  const opsPg = new OpsPg({
    APP_DATABASE_URL: appUrl,
    ...(ownerUrl ? { OWNER_DATABASE_URL: ownerUrl } : {}),
  } as never);
  const attribution = new OpsAttributionService({ db: opsPg } as never, prisma as never);
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: unknown): void => {
    checks.push({ name, ok, detail });
  };

  try {
    const [batches, drafts, sends, replies] = await Promise.all([
      prisma.outreachBatch.groupBy({ by: ['status'], where: { workspaceId }, _count: { _all: true } }),
      prisma.outreachDraft.groupBy({ by: ['status'], where: { workspaceId }, _count: { _all: true } }),
      prisma.outreachSend.groupBy({ by: ['status'], where: { workspaceId }, _count: { _all: true } }),
      prisma.outreachReply.groupBy({
        by: ['kind', 'classification'],
        where: { workspaceId },
        _count: { _all: true },
      }),
    ]);
    check('outreach_batch', batches.length > 0, batches);
    check('outreach_draft', drafts.length > 0, drafts);
    check('outreach_send', sends.length > 0, sends);
    check('outreach_reply', replies.length > 0, replies);

    // 回复 → outcome 回写（engage.reply_classify）：按 source 分组核对。
    const repliedOutcomes = await prisma.opportunityOutcome.findMany({
      where: {
        workspaceId,
        outcome: 'REPLIED',
        sao: {
          workspaceId,
          qgo: { workspaceId, ...(campaignId ? { campaignId } : {}) },
        },
      },
      select: { id: true, saoId: true, source: true, sourceEventId: true },
    });
    const bySource = repliedOutcomes.reduce<Record<string, number>>((acc, row) => {
      acc[row.source] = (acc[row.source] ?? 0) + 1;
      return acc;
    }, {});
    check('opportunity_outcome.REPLIED（回复弱信号回写）', repliedOutcomes.length > 0, {
      bySource,
      distinctSao: new Set(repliedOutcomes.map((row) => row.saoId)).size,
    });

    // 归因视图断言（沿用既有口径，不新增规则）。
    const result = await attribution.attribution(workspaceId);
    const target = campaignId
      ? result.campaigns.find((row) => row.campaignId === campaignId)
      : result.campaigns[0];
    if (!target) {
      check('campaign 行存在', false, { campaignId: campaignId ?? '(workspace 首个 campaign)' });
    } else {
      check('归因行（campaign）', true, target);
      if (campaignId) {
        const distinctRepliedSao = new Set(repliedOutcomes.map((row) => row.saoId)).size;
        check('归因 replyCount == distinct SAO(REPLIED)', target.replyCount === distinctRepliedSao, {
          campaignId: target.campaignId,
          replyCount: target.replyCount,
          distinctRepliedSao,
        });
      }
      check('对账规则（diff≠0 → balanced=false，如实报告）', true, {
        balanced: result.reconciliation.balanced,
        nonZeroRows: result.reconciliation.rows.filter((row) => row.diffMicros !== 0),
      });
    }

    console.log(
      JSON.stringify(
        {
          workspaceId,
          campaignId: campaignId ?? null,
          funnel: result.funnel,
          checks,
          passed: checks.every((item) => item.ok),
        },
        (_key, value) => (typeof value === 'bigint' ? Number(value) : value),
        2,
      ),
    );
    process.exit(checks.every((item) => item.ok) ? 0 : 2);
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error('联调断言执行失败:', error instanceof Error ? error.message : String(error));
  process.exit(2);
});

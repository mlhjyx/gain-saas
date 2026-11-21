import '../shared/load-env.js';
/**
 * 一企一空间存量收编（2026-11-21 产品决策）：
 *  1) 同企业重复工作空间：数据多的一侧为保留侧,空侧的用户先补进保留侧(admin),
 *     原 membership 置 left,空侧 workspace ARCHIVED + registry 停轮询。
 *  2) 验收/测试空间(@example.test、验收命名模式)与 0 成员回填孤儿：同样归档停轮询。
 *  3) 双侧都有数据的重复：只标 NEEDS_MANUAL,绝不自动动(引擎侧 lead/run 以
 *     workspace UUID 为 RLS 锚点,搬移需引擎负责人专项)。
 *
 * 原则:不物理删任何行(audit/membership/invitation/registry 均为 restrict FK,
 * 且保留可逆性);默认 --dry-run,--apply 才写库。
 *
 * 运行:pnpm bootstrap:consolidate [--apply]
 */
import { PrismaService } from '../shared/prisma.service.js';
// 与注册闸门同一套企业名比对(NFKC 归一化 + 精确/包含),避免"公司名1"式后缀漏配
import { findEnterpriseConflict } from '../tenant/auth.service.js';

const APPLY = process.argv.includes('--apply');

/** 验收/测试空间的命名与账号模式(与历史验收记录对齐;宁可漏配也不误归档真实企业)。 */
const TEST_NAME_PATTERNS = [
  /^配额端到端验证/,
  /^(P1|P5)[ _]?验收/,
  /^(抓取|影子)验收/,
  /^引导(复现|验证)/,
  /^M2 .*E2E Demo$/,
  /^wt-wizard-/,
  /^wizard-test-/,
  /^12-3 rehearsal$/,
  /^11$/,
  /^123$/,
  /^引擎存量工作空间 /,
];

interface Tally {
  runLinks: number;
  tasks: number;
  leads: number;
  campaigns: number;
  batches: number;
  sends: number;
  inbox: number;
  compliance: number;
  members: number;
}

async function tally(prisma: PrismaService, workspaceId: string): Promise<Tally> {
  const [runLinks, tasks, leads, campaigns, batches, sends, inbox, compliance, members] = await Promise.all([
    prisma.discoveryRunLink.count({ where: { workspaceId } }),
    prisma.acquisitionTask.count({ where: { workspaceId } }),
    prisma.qualifiedLead.count({ where: { workspaceId } }),
    prisma.campaign.count({ where: { workspaceId } }),
    prisma.outreachBatch.count({ where: { workspaceId } }),
    prisma.outreachSend.count({ where: { workspaceId } }),
    prisma.eventInbox.count({ where: { workspaceId } }),
    prisma.workspaceComplianceDeclaration.count({ where: { workspaceId } }),
    prisma.membership.count({ where: { workspaceId, status: 'active' } }),
  ]);
  return { runLinks, tasks, leads, campaigns, batches, sends, inbox, compliance, members };
}

/** 业务数据量(不含 inbox/members——那是基础设施与成员,不算"业务留存")。 */
function businessWeight(t: Tally): number {
  return t.runLinks + t.tasks + t.leads + t.campaigns + t.batches + t.sends + t.compliance;
}

function isTestWorkspace(name: string): boolean {
  return TEST_NAME_PATTERNS.some((re) => re.test(name.trim()));
}

async function archive(
  prisma: PrismaService,
  workspaceId: string,
  label: string,
  log: (line: string) => void,
): Promise<void> {
  if (!APPLY) {
    log(`  [dry-run] 将归档 ${label} ${workspaceId}(ARCHIVED + registry 停轮询)`);
    return;
  }
  await prisma.workspaceRegistry.updateMany({ where: { workspaceId }, data: { enabled: false } });
  await prisma.workspace.update({ where: { id: workspaceId }, data: { status: 'ARCHIVED' } });
  log(`  已归档 ${label} ${workspaceId}`);
}

async function main(): Promise<void> {
  const prisma = new PrismaService();
  const log = (line: string): void => console.log(line);
  try {
    log(`一企一空间存量收编 — 模式:${APPLY ? 'APPLY(写库)' : 'DRY-RUN(只读)'}`);
    const workspaces = await prisma.workspace.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, name: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    log(`ACTIVE 工作空间共 ${workspaces.length} 个`);

    // ── 1) 聚类找重复(与注册闸门同规则:精确或包含) ──
    const clusters: Array<{ name: string; members: typeof workspaces }> = [];
    for (const w of workspaces) {
      const rep = findEnterpriseConflict(
        w.name,
        clusters.map((c) => c.name),
      );
      if (rep === null) {
        clusters.push({ name: w.name, members: [w] });
      } else {
        clusters.find((c) => c.name === rep)!.members.push(w);
      }
    }
    const duplicates = clusters.filter((g) => g.members.length > 1).map((g) => g.members);
    for (const group of duplicates) {
      log(`\n重复组:${group.map((w) => `${w.name}(${w.id.slice(0, 8)}, ${w.createdAt.toISOString().slice(0, 10)})`).join(' / ')}`);
      const tallies = await Promise.all(group.map((w) => tally(prisma, w.id)));
      const weights = tallies.map(businessWeight);
      const maxWeight = Math.max(...weights);
      const keepIdx = weights.lastIndexOf(maxWeight);
      if (maxWeight > 0 && weights.filter((w) => w > 0).length > 1) {
        log(`  ⚠️ NEEDS_MANUAL:多侧有业务数据(${group.map((w, i) => `${w.id.slice(0, 8)}=${weights[i]}`).join(', ')}),不自动合并——引擎侧数据搬移留引擎负责人专项`);
        continue;
      }
      const keep = group[keepIdx]!;
      log(`  保留侧:${keep.name}(${keep.id.slice(0, 8)},业务数据 ${maxWeight})`);
      for (let i = 0; i < group.length; i += 1) {
        if (i === keepIdx) continue;
        const drop = group[i]!;
        const t = tallies[i]!;
        if (businessWeight(t) > 0) continue; // 上面 NEEDS_MANUAL 分支已兜住,双保险
        // 空侧成员先补进保留侧(保证人人有活跃空间、保留侧不丢 admin)
        const memberships = await prisma.membership.findMany({ where: { workspaceId: drop.id, status: 'active' } });
        for (const m of memberships) {
          const inKeep = await prisma.membership.findFirst({ where: { workspaceId: keep.id, userId: m.userId, status: 'active' } });
          if (inKeep) {
            log(`  成员 ${m.userId} 已在保留侧(${inKeep.role}),原侧 membership 将置 left`);
          } else if (!APPLY) {
            log(`  [dry-run] 将把成员 ${m.userId}(${m.role})补进保留侧 admin`);
          } else {
            await prisma.membership.create({ data: { userId: m.userId, workspaceId: keep.id, role: 'admin' } });
            log(`  成员 ${m.userId} 已补进保留侧 admin`);
          }
        }
        await archive(prisma, drop.id, `空侧「${drop.name}」`, log);
      }
    }

    // ── 2) 测试空间与孤儿归档 ──
    log('\n测试/验收空间与孤儿归档:');
    let archivedTests = 0;
    for (const w of workspaces) {
      const inDupGroup = duplicates.some((g) => g.some((x) => x.id === w.id));
      const memberships = await prisma.membership.count({ where: { workspaceId: w.id, status: 'active' } });
      const orphan = memberships === 0;
      if (!isTestWorkspace(w.name) && !orphan) continue;
      if (inDupGroup) continue; // 重复组已处理,避免双重动作
      const t = await tally(prisma, w.id);
      const isRealUser = await prisma.membership.findFirst({
        where: { workspaceId: w.id, status: 'active', user: { email: { not: { endsWith: '@example.test' } } } },
      });
      if (isRealUser && !orphan && !isTestWorkspace(w.name)) continue; // 真实用户非测试名,不动
      // 测试空间若有真实业务数据也先标记不自动动(验收留痕)
      if (businessWeight(t) > 0) {
        log(`  ⚠️ ${w.name}(${w.id.slice(0, 8)})命中测试模式但有业务数据(线索 ${t.leads}/任务 ${t.tasks}/批次 ${t.batches})→ 标记 SKIP,人工确认`);
        continue;
      }
      await archive(prisma, w.id, `测试/孤儿「${w.name}」`, log);
      archivedTests += 1;
    }
    log(`\n测试/孤儿归档条目:${archivedTests}`);
    log(APPLY ? '完成。' : 'dry-run 结束(未写库)。确认输出后加 --apply 执行。');
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

void main();

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service.js';
import { modificationDistance } from './campaign-plan-diff.js';
import { OpsDatabase } from './ops-database.service.js';

/**
 * Campaign 指标查询层（M2.2 设计 §5，D-M2.2-e：四指标现算，不建新事实表）。
 *
 * 口径钉死（与设计逐条对应）：
 *  - 审批通过率 = APPROVED / (APPROVED + DECLINED + EXPIRED)，按 workspace×campaign×周；
 *    PENDING 且已过 expiresAt 的审批按既有惰性投影口径计为 EXPIRED（与 decide 路径一致）。
 *  - 每通过计划成本 = 窗口内规划轮次成本合计 / 通过数。优先取
 *    `campaign_decision_trace.cost_actual_micros`（SaaS 侧已有字段）；无行时回退到引擎库
 *    `usage_ledger`（ref_type/meta 标记 campaign.plan）；两者都无数据时如实返回
 *    `pending`（引擎归属随 M2.2-1 接线），不返回 0 冒充「零成本」。
 *  - 人工修改距离 = 批准 revision 与**首稿**（最小 revision_no）的叶子字段 diff 数；
 *    0 表示零修改通过（D-M2.2-c 结构距离）。
 *  - 重规划轮次分布 = 每个 campaign 的 `decision_type='campaign.replan'` 轨迹行数，
 *    分桶 0/1/2/3+（引擎侧 M2.2-1 开始写行前恒为 0）。
 *  - 回复/会议率：预留（步 12 归因），不实现。
 *
 * 仅运营域使用（OpsController 的 OpsGuard 之后）；租户接口不可达。
 */

export interface CampaignMetricsQuery {
  readonly workspaceId?: string;
  readonly from: Date;
  readonly to: Date;
  readonly now?: Date;
}

export interface WeeklyApprovalBucket {
  readonly weekStart: string;
  readonly approved: number;
  readonly declined: number;
  readonly expired: number;
  readonly pending: number;
  readonly approvalRate: number | null;
}

export interface CampaignCostStatus {
  readonly status: 'ok' | 'pending';
  readonly source: 'campaign_decision_trace' | 'usage_ledger' | null;
  readonly totalCostMicros: number | null;
  readonly costPerApprovedPlanMicros: number | null;
  readonly reason?: string;
}

export interface CampaignMetricsResult {
  readonly generatedAt: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly workspaceId: string | null;
  readonly approvals: {
    readonly approved: number;
    readonly declined: number;
    readonly expired: number;
    readonly pending: number;
    readonly approvalRate: number | null;
    readonly rateDenominator: number;
  };
  readonly weekly: readonly WeeklyApprovalBucket[];
  readonly modification: {
    readonly approvedPlans: number;
    readonly meanDistance: number | null;
    readonly zeroDistanceCount: number;
    readonly perCampaign: readonly { campaignId: string; distance: number }[];
  };
  readonly replans: {
    readonly distribution: { rounds0: number; rounds1: number; rounds2: number; rounds3plus: number };
    readonly perCampaign: readonly { campaignId: string; rounds: number }[];
  };
  readonly cost: CampaignCostStatus;
  readonly replyMeetingRate: { readonly status: 'reserved'; readonly note: string };
}

type ApprovalRow = {
  id: string;
  revisionId: string;
  state: string;
  decidedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  revision: { campaignId: string };
};

type RevisionRow = { id: string; campaignId: string; revisionNo: number; plan: unknown };

type TraceRow = { campaignId: string | null; costActualMicros: bigint | null };

/** UTC 周一起点（周桶键）。 */
export function utcWeekStart(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0=Sun
  const diff = (day + 6) % 7;
  return new Date(d.getTime() - diff * 24 * 60 * 60 * 1000);
}

function effectiveState(row: ApprovalRow, now: Date): 'APPROVED' | 'DECLINED' | 'EXPIRED' | 'PENDING' {
  if (row.state === 'PENDING' && row.expiresAt <= now) return 'EXPIRED';
  if (row.state === 'APPROVED' || row.state === 'DECLINED' || row.state === 'EXPIRED') return row.state;
  return 'PENDING';
}

function weekIndexKey(date: Date): string {
  return utcWeekStart(date).toISOString();
}

@Injectable()
export class OpsCampaignMetricsService {
  private readonly log = new Logger(OpsCampaignMetricsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly opsDatabase: OpsDatabase,
  ) {}

  async campaignMetrics(query: CampaignMetricsQuery): Promise<CampaignMetricsResult> {
    const now = query.now ?? new Date();
    const { from, to } = query;
    const workspaceFilter = query.workspaceId ? { workspaceId: query.workspaceId } : {};

    const approvals = (await this.prisma.campaignApproval.findMany({
      where: { ...workspaceFilter, createdAt: { gte: from, lt: to } },
      select: {
        id: true,
        revisionId: true,
        state: true,
        decidedAt: true,
        expiresAt: true,
        createdAt: true,
        revision: { select: { campaignId: true } },
      },
    })) as ApprovalRow[];

    const buckets = new Map<string, { approved: number; declined: number; expired: number; pending: number }>();
    const totals = { approved: 0, declined: 0, expired: 0, pending: 0 };
    for (const row of approvals) {
      const state = effectiveState(row, now);
      const stamp = row.decidedAt ?? (state === 'EXPIRED' ? row.expiresAt : row.createdAt);
      const key = weekIndexKey(stamp);
      const bucket = buckets.get(key) ?? { approved: 0, declined: 0, expired: 0, pending: 0 };
      if (state === 'APPROVED') bucket.approved += 1;
      else if (state === 'DECLINED') bucket.declined += 1;
      else if (state === 'EXPIRED') bucket.expired += 1;
      else bucket.pending += 1;
      buckets.set(key, bucket);
    }
    for (const row of approvals) {
      const state = effectiveState(row, now);
      if (state === 'APPROVED') totals.approved += 1;
      else if (state === 'DECLINED') totals.declined += 1;
      else if (state === 'EXPIRED') totals.expired += 1;
      else totals.pending += 1;
    }
    const rateDenominator = totals.approved + totals.declined + totals.expired;
    const rate = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 10000) / 10000);
    const weekly: WeeklyApprovalBucket[] = [...buckets.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([weekStart, b]) => ({
        weekStart,
        approved: b.approved,
        declined: b.declined,
        expired: b.expired,
        pending: b.pending,
        approvalRate: rate(b.approved, b.approved + b.declined + b.expired),
      }));

    // 修改距离：批准 revision 与同 campaign 首稿（最小 revision_no）的结构 diff。
    const approvedRevisions = approvals.filter((row) => effectiveState(row, now) === 'APPROVED');
    const modification = await this.modificationDistance(approvedRevisions);

    // 重规划轮次：campaign.replan 轨迹行按 campaign 计数。
    const traces = (await this.prisma.campaignDecisionTrace.findMany({
      where: { decisionType: 'campaign.replan', ...workspaceFilter, createdAt: { gte: from, lt: to } },
      select: { campaignId: true, costActualMicros: true },
    })) as TraceRow[];
    const roundsByCampaign = new Map<string, number>();
    for (const trace of traces) {
      if (typeof trace.campaignId !== 'string') continue;
      roundsByCampaign.set(trace.campaignId, (roundsByCampaign.get(trace.campaignId) ?? 0) + 1);
    }
    const campaignIds = new Set<string>();
    for (const row of approvals) campaignIds.add(row.revision.campaignId);
    for (const id of roundsByCampaign.keys()) campaignIds.add(id);
    const perCampaign = [...campaignIds]
      .sort()
      .map((campaignId) => ({ campaignId, rounds: roundsByCampaign.get(campaignId) ?? 0 }));
    const distribution = { rounds0: 0, rounds1: 0, rounds2: 0, rounds3plus: 0 };
    for (const entry of perCampaign) {
      if (entry.rounds <= 0) distribution.rounds0 += 1;
      else if (entry.rounds === 1) distribution.rounds1 += 1;
      else if (entry.rounds === 2) distribution.rounds2 += 1;
      else distribution.rounds3plus += 1;
    }

    const cost = await this.costStatus(traces, totals.approved, from, to);

    return {
      generatedAt: now.toISOString(),
      window: { from: from.toISOString(), to: to.toISOString() },
      workspaceId: query.workspaceId ?? null,
      approvals: { ...totals, approvalRate: rate(totals.approved, rateDenominator), rateDenominator },
      weekly,
      modification,
      replans: { distribution, perCampaign },
      cost,
      replyMeetingRate: { status: 'reserved', note: '等待步 12 outcome 归因接入（设计 §5 预留）' },
    };
  }

  private async modificationDistance(
    approvedRevisions: ApprovalRow[],
  ): Promise<CampaignMetricsResult['modification']> {
    if (approvedRevisions.length === 0) {
      return { approvedPlans: 0, meanDistance: null, zeroDistanceCount: 0, perCampaign: [] };
    }
    const revisionIds = [...new Set(approvedRevisions.map((row) => row.revisionId))];
    const revisions = (await this.prisma.campaignRevision.findMany({
      where: { id: { in: revisionIds } },
      select: { id: true, campaignId: true, revisionNo: true, plan: true },
    })) as RevisionRow[];
    const campaignIds = [...new Set(revisions.map((row) => row.campaignId))];
    const allRevisions = (await this.prisma.campaignRevision.findMany({
      where: { campaignId: { in: campaignIds } },
      select: { id: true, campaignId: true, revisionNo: true, plan: true },
    })) as RevisionRow[];
    const firstByCampaign = new Map<string, RevisionRow>();
    for (const revision of allRevisions) {
      const current = firstByCampaign.get(revision.campaignId);
      if (!current || revision.revisionNo < current.revisionNo) {
        firstByCampaign.set(revision.campaignId, revision);
      }
    }
    const perCampaign: { campaignId: string; distance: number }[] = [];
    let sum = 0;
    let zero = 0;
    for (const revision of revisions) {
      const first = firstByCampaign.get(revision.campaignId);
      if (!first) continue;
      const distance = modificationDistance(first.plan, revision.plan);
      perCampaign.push({ campaignId: revision.campaignId, distance });
      sum += distance;
      if (distance === 0) zero += 1;
    }
    perCampaign.sort((a, b) => (a.campaignId < b.campaignId ? -1 : 1));
    return {
      approvedPlans: perCampaign.length,
      meanDistance: perCampaign.length === 0 ? null : Math.round((sum / perCampaign.length) * 100) / 100,
      zeroDistanceCount: zero,
      perCampaign,
    };
  }

  /** 每通过计划成本：先 SaaS 轨迹成本字段，再引擎 usage_ledger；无数据如实 pending。 */
  private async costStatus(
    traces: TraceRow[],
    approvedCount: number,
    from: Date,
    to: Date,
  ): Promise<CampaignCostStatus> {
    const traceCosts = traces.filter((row) => row.costActualMicros !== null);
    if (traceCosts.length > 0) {
      const total = traceCosts.reduce((acc, row) => acc + Number(row.costActualMicros), 0);
      return {
        status: 'ok',
        source: 'campaign_decision_trace',
        totalCostMicros: total,
        costPerApprovedPlanMicros: approvedCount > 0 ? Math.round(total / approvedCount) : null,
      };
    }
    try {
      const rows = (await this.opsDatabase.db.query(
        `SELECT COALESCE(meta->>'campaignId', ref_id) AS campaign_id, SUM(cost_usd) AS cost_usd
         FROM usage_ledger
         WHERE (ref_type = 'campaign.plan' OR meta->>'purpose' = 'campaign.plan')
           AND created_at >= $1 AND created_at < $2
         GROUP BY 1`,
        [from.toISOString(), to.toISOString()],
      )) as { cost_usd: number | string | null }[];
      const totalUsd = rows.reduce((acc, row) => acc + Number(row.cost_usd ?? 0), 0);
      if (rows.length === 0) {
        return {
          status: 'pending',
          source: null,
          totalCostMicros: null,
          costPerApprovedPlanMicros: null,
          reason: '引擎 usage_ledger 尚无 campaign.plan 归属行（M2.2-1 成本接线前）',
        };
      }
      const totalMicros = Math.round(totalUsd * 1_000_000);
      return {
        status: 'ok',
        source: 'usage_ledger',
        totalCostMicros: totalMicros,
        costPerApprovedPlanMicros: approvedCount > 0 ? Math.round(totalMicros / approvedCount) : null,
      };
    } catch (error) {
      this.log.warn(`campaign metrics: engine usage query unavailable: ${String(error)}`);
      return {
        status: 'pending',
        source: null,
        totalCostMicros: null,
        costPerApprovedPlanMicros: null,
        reason: '引擎运营库不可用（OPS_DATABASE_URL 未配置或连接失败）',
      };
    }
  }
}

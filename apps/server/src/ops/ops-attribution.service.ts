import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../shared/prisma.service.js';
import { OpsDatabase } from './ops-database.service.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * M2 步 12-1：campaign.plan 任务在引擎 usage_ledger 的真实元数据形状（2026-11-08 实测，
 * global_dev）：{"task":"campaign.plan","model":…,"runId":"campaign.plan:campaign:<campaignId>:<hash>",…}。
 * 不是 job/campaignId 键——旧假设会让 plan 侧引擎成本静默归零（假绿）。
 */
const PLAN_TASK_META_KEY = 'task';
const PLAN_RUN_ID_META_KEY = 'runId';
const PLAN_TASK_VALUE = 'campaign.plan';
const PLAN_RUN_ID_KIND_SEGMENT = 'campaign';

export interface AttributionCampaignRow {
  campaignId: string;
  campaignName: string;
  campaignStatus: string;
  execCostMicros: number;
  planCostMicros: number;
  spendTotalMicros: number;
  qgoCount: number;
  saoCount: number;
  positiveCount: number;
  replyCount: number;
  negativeCount: number;
  costPerPositiveMicros: number | null;
  pipelinePerDollar: null;
}

export interface AttributionReconciliationRow {
  campaignId: string;
  campaignName: string;
  /** 视图值（SaaS 账本 cost_ledger 归集）。 */
  execViewMicros: number;
  /** 独立重算值（原始表直查，用于发现视图/定义漂移）。 */
  execLedgerMicros: number;
  /** 视图值（v0 为 0 占位）。 */
  planViewMicros: number;
  /** 引擎 usage_ledger 归集（meta.task='campaign.plan'，campaignId 取自 meta.runId 的第三段）。 */
  planEngineMicros: number;
  diffMicros: number;
}

export interface AttributionFunnel {
  campaigns: number;
  spendTotalMicros: number;
  execCostMicros: number;
  planCostMicros: number;
  qgoCount: number;
  saoCount: number;
  positiveCount: number;
  replyCount: number;
  negativeCount: number;
}

export interface AttributionResponse {
  funnel: AttributionFunnel;
  campaigns: AttributionCampaignRow[];
  reconciliation: {
    balanced: boolean;
    rows: AttributionReconciliationRow[];
  };
}

type RawCampaignRow = {
  campaign_id: string;
  campaign_name: string;
  campaign_status: string;
  exec_cost_micros: bigint;
  plan_cost_micros: bigint;
  spend_total_micros: bigint;
  qgo_count: bigint;
  sao_count: bigint;
  positive_count: bigint;
  reply_count: bigint;
  negative_count: bigint;
  cost_per_positive_micros: bigint | null;
  pipeline_per_dollar: Prisma.Decimal | null;
};

type RawLedgerRow = {
  campaign_id: string;
  exec_ledger_micros: bigint;
};

type RawEnginePlanRow = {
  campaign_id: string | null;
  plan_engine_micros: bigint;
};

function assertWorkspaceId(workspaceId: string): void {
  if (!UUID_RE.test(workspaceId)) {
    throw new BadRequestException({
      error: { code: 'VALIDATION', message: 'workspace id 必须是 UUID' },
    });
  }
}

function micros(value: bigint | null | undefined): number {
  return Number(value ?? 0n);
}

/**
 * M2 步 12-1 归因闭环（D-12-a~e，设计 docs/superpowers/plans/2026-11-08-opportunity-attribution-m2-step12.md）：
 * - campaigns：只读视图 v_campaign_attribution（直归因、账本现算）；
 * - reconciliation：视图值 ↔ 原始表独立重算（exec 侧，抓视图/定义漂移）+ 视图 plan 占位 ↔
 *   引擎 usage_ledger（plan 侧，M2.1 planner 落地后真实出数）。任一行 diff≠0 → balanced=false，
 *   归因页显示「差异 N µUSD」。
 */
@Injectable()
export class OpsAttributionService {
  constructor(
    private readonly database: OpsDatabase,
    private readonly prisma: PrismaService,
  ) {}

  async attribution(workspaceId: string): Promise<AttributionResponse> {
    assertWorkspaceId(workspaceId);
    const rawRows = await this.prisma.$queryRaw<RawCampaignRow[]>(Prisma.sql`
      SELECT *
      FROM "v_campaign_attribution"
      WHERE "workspace_id" = ${workspaceId}::uuid
      ORDER BY "spend_total_micros" DESC, "campaign_name" ASC
    `);
    const campaigns: AttributionCampaignRow[] = rawRows.map((row) => ({
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      campaignStatus: row.campaign_status,
      execCostMicros: micros(row.exec_cost_micros),
      planCostMicros: micros(row.plan_cost_micros),
      spendTotalMicros: micros(row.spend_total_micros),
      qgoCount: micros(row.qgo_count),
      saoCount: micros(row.sao_count),
      positiveCount: micros(row.positive_count),
      replyCount: micros(row.reply_count),
      negativeCount: micros(row.negative_count),
      costPerPositiveMicros:
        row.cost_per_positive_micros === null ? null : micros(row.cost_per_positive_micros),
      pipelinePerDollar: null,
    }));
    const rows = await this.reconcile(workspaceId, campaigns);
    return {
      funnel: {
        campaigns: campaigns.length,
        spendTotalMicros: campaigns.reduce((sum, row) => sum + row.spendTotalMicros, 0),
        execCostMicros: campaigns.reduce((sum, row) => sum + row.execCostMicros, 0),
        planCostMicros: campaigns.reduce((sum, row) => sum + row.planCostMicros, 0),
        qgoCount: campaigns.reduce((sum, row) => sum + row.qgoCount, 0),
        saoCount: campaigns.reduce((sum, row) => sum + row.saoCount, 0),
        positiveCount: campaigns.reduce((sum, row) => sum + row.positiveCount, 0),
        replyCount: campaigns.reduce((sum, row) => sum + row.replyCount, 0),
        negativeCount: campaigns.reduce((sum, row) => sum + row.negativeCount, 0),
      },
      campaigns,
      reconciliation: {
        balanced: rows.every((row) => row.diffMicros === 0),
        rows,
      },
    };
  }

  /**
   * 对账（验收核心）：逐 campaign
   *   exec：视图 exec_cost_micros == 原始表独立重算（cost_ledger 经 event_inbox.planId 归集，
   *         独立 SQL 直查，不读视图）；
   *   plan：视图 plan_cost_micros（v0=0）== 引擎 usage_ledger 的 campaign.plan 归集合计。
   * 一分不差；任一差异或引擎侧出现视图未知的 campaign 成本 → diff≠0。
   */
  async reconcile(
    workspaceId: string,
    campaigns: AttributionCampaignRow[],
  ): Promise<AttributionReconciliationRow[]> {
    const ledgerRows = await this.prisma.$queryRaw<RawLedgerRow[]>(Prisma.sql`
      WITH "auth_icps" AS (
        SELECT
          a."workspace_id", a."campaign_id", (icp.value)::uuid AS "icp_id", a."issued_at"
        FROM "campaign_execution_authorization" AS a
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(a."scope" -> 'actions', '[]'::jsonb)) AS action
        CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(action -> 'icpIds', '[]'::jsonb)) AS icp
        WHERE a."workspace_id" = ${workspaceId}::uuid
      ),
      "campaign_icps" AS (
        SELECT "workspace_id", "campaign_id", "icp_id", min("issued_at") AS "first_issued_at"
        FROM "auth_icps" GROUP BY 1, 2, 3
      ),
      "campaign_plans" AS (
        SELECT DISTINCT ci."campaign_id", l."plan_id"
        FROM "campaign_icps" AS ci
        JOIN "discovery_run_link" AS l
          ON l."workspace_id" = ci."workspace_id"
         AND l."icp_id" = ci."icp_id"
         AND l."created_at" >= ci."first_issued_at"
      )
      SELECT cp."campaign_id", COALESCE(sum(cl."amount_micros"), 0)::bigint AS "exec_ledger_micros"
      FROM "campaign_plans" AS cp
      JOIN "event_inbox" AS e
        ON e."workspace_id" = ${workspaceId}::uuid
       AND (e."payload" ->> 'planId') = cp."plan_id"::text
      JOIN "cost_ledger" AS cl
        ON cl."workspace_id" = e."workspace_id"
       AND cl."source_event_id" = e."event_id"
      GROUP BY 1
    `);
    const ledgerByCampaign = new Map(
      ledgerRows.map((row) => [row.campaign_id, micros(row.exec_ledger_micros)]),
    );

    const engineRows = await this.database.db.withWorkspace(workspaceId, async (client) => {
      // campaignId 从 runId 解析：campaign.plan:campaign:<campaignId>:<hash>（split_part 1/2/3）。
      const result = await client.query<RawEnginePlanRow>(
        `SELECT NULLIF(split_part(meta ->> $2, ':', 3), '') AS campaign_id,
                COALESCE(sum(round(cost_usd * 1000000)), 0)::bigint AS plan_engine_micros
         FROM usage_ledger
         WHERE (meta ->> $1) = $3
           AND split_part(meta ->> $2, ':', 1) = $3
           AND split_part(meta ->> $2, ':', 2) = $4
           AND NULLIF(split_part(meta ->> $2, ':', 3), '') IS NOT NULL
         GROUP BY 1`,
        [PLAN_TASK_META_KEY, PLAN_RUN_ID_META_KEY, PLAN_TASK_VALUE, PLAN_RUN_ID_KIND_SEGMENT],
      );
      return result.rows;
    });
    const enginePlanByCampaign = new Map<string, number>();
    let engineOnlyMicros = 0;
    const knownCampaigns = new Set(campaigns.map((row) => row.campaignId));
    for (const row of engineRows) {
      if (!row.campaign_id) continue;
      const value = micros(row.plan_engine_micros);
      if (knownCampaigns.has(row.campaign_id)) {
        enginePlanByCampaign.set(
          row.campaign_id,
          (enginePlanByCampaign.get(row.campaign_id) ?? 0) + value,
        );
      } else {
        engineOnlyMicros += value;
      }
    }

    const rows: AttributionReconciliationRow[] = campaigns.map((row) => {
      const execLedger = ledgerByCampaign.get(row.campaignId) ?? 0;
      const planEngine = enginePlanByCampaign.get(row.campaignId) ?? 0;
      return {
        campaignId: row.campaignId,
        campaignName: row.campaignName,
        execViewMicros: row.execCostMicros,
        execLedgerMicros: execLedger,
        planViewMicros: row.planCostMicros,
        planEngineMicros: planEngine,
        diffMicros: row.execCostMicros - execLedger + row.planCostMicros - planEngine,
      };
    });
    // 引擎侧出现视图未知的 campaign 成本 = 归属缺口：以一条合成行暴露，绝不吞掉。
    if (engineOnlyMicros !== 0) {
      rows.push({
        campaignId: '00000000-0000-0000-0000-000000000000',
        campaignName: '(引擎侧未知 campaign)',
        execViewMicros: 0,
        execLedgerMicros: 0,
        planViewMicros: 0,
        planEngineMicros: engineOnlyMicros,
        diffMicros: -engineOnlyMicros,
      });
    }
    return rows;
  }
}

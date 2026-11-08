-- M2 步 12-1（设计 docs/superpowers/plans/2026-11-08-opportunity-attribution-m2-step12.md，APPROVED；D-12-a~e）：
-- 归因闭环 v0 —— 只读 SQL 视图，不建新事实表、不改 QGO 三表结构。
--
-- 链：opportunity_outcome → sao → qgo → campaign(可空)。
-- 授权 run 集（v0 直归因）：campaign 的 execution authorization scope.actions[].icpIds 并集
--   ∩ discovery_run_link.icp_id，且 run 链接创建时间不早于该 ICP 授权的最早 issued_at。
-- exec 成本：cost_ledger（source_event_id = 引擎事件 event_id）经 event_inbox.payload.planId
--   归到授权 run 集涉及的 plan。引擎 DiscoveryRunCompleted 载荷只带 planId（无 runId），
--   v0 以 plan 为成本归集粒度；引擎事件补 runId 后仅换 join 键、口径不变。
-- plan 成本：v0 = 0 占位。campaign.plan 任务在 M2.1 落地后写入引擎 usage_ledger
--   （meta.job='campaign.plan'、meta.campaignId=<id>）；归属与对账由 ops 归因服务完成，
--   本视图不回读引擎库（D-12-b）。
-- 归因类型：qgo.campaign_id 为空 → ORGANIC；campaign 行不存在（跨库引用失效）→ UNKNOWN；
--   否则 CAMPAIGN。ORGANIC/UNKNOWN 不计入 campaign 北极星分母（D-12-a）。

CREATE OR REPLACE VIEW "v_campaign_attribution" AS
WITH "auth_icps" AS (
  SELECT
    a."workspace_id",
    a."campaign_id",
    CASE
      WHEN icp.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN (icp.value)::uuid
      ELSE NULL
    END AS "icp_id",
    a."issued_at"
  FROM "campaign_execution_authorization" AS a
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(a."scope" -> 'actions', '[]'::jsonb)) AS action
  CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(action -> 'icpIds', '[]'::jsonb)) AS icp
),
"campaign_icps" AS (
  SELECT "workspace_id", "campaign_id", "icp_id", min("issued_at") AS "first_issued_at"
  FROM "auth_icps"
  GROUP BY 1, 2, 3
),
"campaign_plans" AS (
  SELECT DISTINCT ci."workspace_id", ci."campaign_id", l."plan_id"
  FROM "campaign_icps" AS ci
  JOIN "discovery_run_link" AS l
    ON l."workspace_id" = ci."workspace_id"
   AND l."icp_id" = ci."icp_id"
   AND l."created_at" >= ci."first_issued_at"
),
"plan_costs" AS (
  SELECT
    cp."workspace_id",
    cp."campaign_id",
    COALESCE(sum(cl."amount_micros"), 0)::bigint AS "exec_cost_micros"
  FROM "campaign_plans" AS cp
  JOIN "event_inbox" AS e
    ON e."workspace_id" = cp."workspace_id"
   AND (e."payload" ->> 'planId') = cp."plan_id"::text
  JOIN "cost_ledger" AS cl
    ON cl."workspace_id" = e."workspace_id"
   AND cl."source_event_id" = e."event_id"
  GROUP BY 1, 2
),
"qgo_stats" AS (
  SELECT q."workspace_id", q."campaign_id", count(*)::bigint AS "qgo_count"
  FROM "qgo" AS q
  WHERE q."campaign_id" IS NOT NULL
  GROUP BY 1, 2
),
"sao_stats" AS (
  SELECT
    q."workspace_id",
    q."campaign_id",
    count(DISTINCT s."id") FILTER (WHERE s."state" = 'ACCEPTED')::bigint AS "sao_count",
    count(DISTINCT s."id") FILTER (
      WHERE s."state" = 'ACCEPTED' AND o."outcome" IN ('MEETING_BOOKED', 'QUOTE_SENT', 'WON')
    )::bigint AS "positive_count",
    count(DISTINCT s."id") FILTER (
      WHERE s."state" = 'ACCEPTED' AND o."outcome" = 'REPLIED'
    )::bigint AS "reply_count",
    count(DISTINCT s."id") FILTER (
      WHERE s."state" = 'ACCEPTED' AND o."outcome" IN ('LOST', 'NO_RESPONSE', 'DISQUALIFIED')
    )::bigint AS "negative_count"
  FROM "qgo" AS q
  JOIN "sao" AS s
    ON s."qgo_id" = q."id" AND s."workspace_id" = q."workspace_id"
  LEFT JOIN "opportunity_outcome" AS o
    ON o."sao_id" = s."id" AND o."workspace_id" = s."workspace_id"
  WHERE q."campaign_id" IS NOT NULL
  GROUP BY 1, 2
)
SELECT
  c."workspace_id",
  c."id" AS "campaign_id",
  c."name" AS "campaign_name",
  c."status"::text AS "campaign_status",
  COALESCE(pc."exec_cost_micros", 0)::bigint AS "exec_cost_micros",
  0::bigint AS "plan_cost_micros",
  COALESCE(pc."exec_cost_micros", 0)::bigint AS "spend_total_micros",
  COALESCE(qs."qgo_count", 0)::bigint AS "qgo_count",
  COALESCE(ss."sao_count", 0)::bigint AS "sao_count",
  COALESCE(ss."positive_count", 0)::bigint AS "positive_count",
  COALESCE(ss."reply_count", 0)::bigint AS "reply_count",
  COALESCE(ss."negative_count", 0)::bigint AS "negative_count",
  CASE
    WHEN COALESCE(ss."positive_count", 0) > 0
      THEN COALESCE(pc."exec_cost_micros", 0) / ss."positive_count"
    ELSE NULL
  END::bigint AS "cost_per_positive_micros",
  NULL::numeric AS "pipeline_per_dollar"
FROM "campaign" AS c
LEFT JOIN "plan_costs" AS pc
  ON pc."workspace_id" = c."workspace_id" AND pc."campaign_id" = c."id"
LEFT JOIN "qgo_stats" AS qs
  ON qs."workspace_id" = c."workspace_id" AND qs."campaign_id" = c."id"
LEFT JOIN "sao_stats" AS ss
  ON ss."workspace_id" = c."workspace_id" AND ss."campaign_id" = c."id";

-- 链视图：outcome 一行，带完整链 id 集、归因类型与「链成本快照」（查询时刻该 campaign
-- 的 exec/plan 成本；v0 不做历史化——成本随账本实时变化，快照即当前值）。
CREATE OR REPLACE VIEW "v_outcome_chain" AS
WITH "auth_icps" AS (
  SELECT
    a."workspace_id",
    a."campaign_id",
    CASE
      WHEN icp.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN (icp.value)::uuid
      ELSE NULL
    END AS "icp_id",
    a."issued_at"
  FROM "campaign_execution_authorization" AS a
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(a."scope" -> 'actions', '[]'::jsonb)) AS action
  CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(action -> 'icpIds', '[]'::jsonb)) AS icp
),
"campaign_icps" AS (
  SELECT "workspace_id", "campaign_id", "icp_id", min("issued_at") AS "first_issued_at"
  FROM "auth_icps"
  GROUP BY 1, 2, 3
),
"campaign_plans" AS (
  SELECT DISTINCT ci."workspace_id", ci."campaign_id", l."plan_id"
  FROM "campaign_icps" AS ci
  JOIN "discovery_run_link" AS l
    ON l."workspace_id" = ci."workspace_id"
   AND l."icp_id" = ci."icp_id"
   AND l."created_at" >= ci."first_issued_at"
),
"plan_costs" AS (
  SELECT
    cp."workspace_id",
    cp."campaign_id",
    COALESCE(sum(cl."amount_micros"), 0)::bigint AS "exec_cost_micros"
  FROM "campaign_plans" AS cp
  JOIN "event_inbox" AS e
    ON e."workspace_id" = cp."workspace_id"
   AND (e."payload" ->> 'planId') = cp."plan_id"::text
  JOIN "cost_ledger" AS cl
    ON cl."workspace_id" = e."workspace_id"
   AND cl."source_event_id" = e."event_id"
  GROUP BY 1, 2
)
SELECT
  o."workspace_id",
  o."id" AS "outcome_id",
  o."outcome" AS "outcome_type",
  o."occurred_at",
  o."source" AS "outcome_source",
  s."id" AS "sao_id",
  s."state" AS "sao_state",
  q."id" AS "qgo_id",
  q."campaign_id",
  CASE
    WHEN q."campaign_id" IS NULL THEN 'ORGANIC'
    WHEN c."id" IS NULL THEN 'UNKNOWN'
    ELSE 'CAMPAIGN'
  END AS "attribution_type",
  COALESCE(pc."exec_cost_micros", 0)::bigint AS "chain_exec_cost_micros",
  0::bigint AS "chain_plan_cost_micros"
FROM "opportunity_outcome" AS o
JOIN "sao" AS s
  ON s."id" = o."sao_id" AND s."workspace_id" = o."workspace_id"
JOIN "qgo" AS q
  ON q."id" = s."qgo_id" AND q."workspace_id" = s."workspace_id"
LEFT JOIN "campaign" AS c
  ON c."id" = q."campaign_id" AND c."workspace_id" = q."workspace_id"
LEFT JOIN "plan_costs" AS pc
  ON pc."workspace_id" = q."workspace_id" AND pc."campaign_id" = q."campaign_id";

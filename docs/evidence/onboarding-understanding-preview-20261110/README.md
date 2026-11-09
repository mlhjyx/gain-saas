# 注册即建档第 1 步——埋点口径与本机数据快照（2026-11-10）

> 文档 ID：`EVIDENCE-ONBOARDING-UNDERSTANDING-PREVIEW-20261110`
> 生命周期：`EVIDENCE`
> 最后核验：2026-11-10

范围：onboarding 反转为「先官网 → 理解预览 → 勾选确认」后的五项指标。数据全部来自
本机 dev 数据库的真实查询（SaaS `gain_saas` @5433、引擎 `global_dev` @5432），**没有任何造数**。
本机没有真实客户流量，快照只用来验证口径与 SQL 可执行，不作为产品结论。

## 埋点

| 事件 | 位置 | detail |
| --- | --- | --- |
| `onboarding.preview_started` | BFF `POST /api/onboarding/preview` | `{companyId, kind: 'website'\|'manual'}` |
| `onboarding.complete` | BFF `POST /api/onboarding/company` | `{companyId, understandingState, pagesAnalyzed, industrySuggested, industryChosen, industryAccepted, productsSuggested, productsChosen, productsAccepted, marketsSuggested, marketsChosen, marketsAccepted}`（预览不可用时 `{metrics:'unavailable'}`） |

审计表是 SaaS 的 `audit_log`（`realm='tenant'`），不依赖引擎侧额外埋点。

## 口径与 SQL

### 1. 注册完成率

```sql
-- 只统计功能上线后注册的空间；存量空间在迁移时回填过 onboarding_completed_at，会虚高。
SELECT count(*) FILTER (WHERE onboarding_completed_at IS NOT NULL)::numeric
         / NULLIF(count(*), 0) AS completion_rate,
       count(*) AS workspaces
FROM workspace
WHERE created_at >= TIMESTAMPTZ '2026-11-10 00:00:00+00';
```

### 2. 理解成功率（预览启动 → 档案最终可确认）

跨两个库，两步查询后按 `companyId`/`workspaceId` 对齐：

```sql
-- SaaS：启动过预览的空间与公司
SELECT target AS workspace_id, detail->>'companyId' AS company_id, at
FROM audit_log WHERE action = 'onboarding.preview_started';

-- 引擎：这些公司最终状态
SELECT id, status FROM company_profile
WHERE id = ANY(:company_ids) AND deleted_at IS NULL;
```

成功率 = 状态为 `REVIEW`/`ACTIVE` 的公司数 ÷ `preview_started` 的公司数。`DRAFT` 且
`understanding_failed_at IS NOT NULL` 计为失败；`DRAFT` 无失败按「未完成」单列。

### 3. 平均覆盖页数

```sql
SELECT avg((detail->>'pagesAnalyzed')::numeric) AS avg_pages,
       count(*) AS samples
FROM audit_log
WHERE action = 'onboarding.complete' AND detail ? 'pagesAnalyzed';
```

页数来自引擎 `knowledge_source(type='website')` 按 URI 去重（重试不会重复计数）。

### 4. 建议修正率（行业/产品/市场）

```sql
SELECT
  sum((detail->>'industrySuggested' IS NOT NULL)::int) AS industry_suggested,
  sum((detail->>'industrySuggested' IS NOT NULL
       AND (detail->>'industryAccepted')::boolean = false)::int) AS industry_changed,
  sum((detail->>'productsSuggested')::int) AS products_suggested,
  sum((detail->>'productsSuggested')::int - (detail->>'productsAccepted')::int) AS products_changed,
  sum((detail->>'marketsSuggested')::int) AS markets_suggested,
  sum((detail->>'marketsSuggested')::int - (detail->>'marketsAccepted')::int) AS markets_changed
FROM audit_log
WHERE action = 'onboarding.complete' AND detail ? 'productsSuggested';
```

修正率 = changed ÷ suggested（未给出建议的项不计入分母；客户新增的产品/市场单独看 chosen - accepted）。

### 5. 首个有效 ICP 时长

`icp_definition` 没有激活时间列，用 ACTIVE 行的 `updated_at` 近似激活时刻：

```sql
-- 引擎
SELECT workspace_id, min(updated_at) AS first_active_at
FROM icp_definition WHERE status = 'ACTIVE' GROUP BY workspace_id;

-- SaaS
SELECT id AS workspace_id, created_at AS registered_at FROM workspace;
```

两表按 `workspace_id` 对齐后，时长 = `first_active_at - registered_at`。

## 本机快照（2026-11-10，dev 数据，非客户数据）

| 指标 | 值 | 说明 |
| --- | --- | --- |
| 工作空间总数 / 已建档 | 40 / 29 | 存量空间在迁移时回填过；功能上线后新注册 = 0 |
| `onboarding.preview_started` | 0 | 本 PR 未部署，埋点尚未产生 |
| `onboarding.complete` 历史记录 | 21 | 均为旧向导路径，无 `pagesAnalyzed` 等新字段 |
| 引擎档案状态（未删除） | DRAFT 55 · ENRICHING 28 · REVIEW 17 · ACTIVE 12 | ENRICHING 为本地历史长尾 |
| `industry_code` 非空 | 无法查询 | 迁移未应用到本机运行库（不部署；部署时 `prisma migrate deploy`） |
| 有 ACTIVE ICP 的工作空间 | 16（与 SaaS 工作空间对齐 15） | ICP 总数 78，其中 ACTIVE 72 |
| 首个有效 ICP 时长（dev 样本，n=15） | p50 0.1h · p90 14.5h · max 118.4h | 含测试夹具，仅验证 SQL 可执行 |

结论：埋点与 SQL 已就绪；当前无功能上线后的真实样本，完成率/理解成功率/修正率需在首次
发布后按上面的查询重跑。报告不填演示数。

## 复现

```bash
# SaaS（不打印凭据，由 apps/server/.env 提供 DATABASE_URL）
set -a; . /global/gain-saas/apps/server/.env; set +a
psql "$DATABASE_URL" -c "<上面的 SQL>"
```

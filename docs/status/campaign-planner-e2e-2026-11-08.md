# M2.1-4 · 受限 Campaign Planner E2E（2026-11-08）

> 生命周期：`EVIDENCE`
> 依据：计划 v1.5 步 9（M2.1-4 联调）与设计 `mlhjyx/global-backend:docs/superpowers/plans/2026-11-08-campaign-planner-m2-1.md` §9。
> 代码：引擎 M2.1-1（mlhjyx/global-backend #876，合并后填 SHA）；本仓 M2.1-2（#75）与 M2.1-3（#80）。

## 1. 本次已验证（stub-engine 模式，真实 HTTP + 真实库）

`apps/server/src/scripts/campaign-e2e.ts --stub-engine`：引擎两个端点由本地 stub 实现
（workspace 技术 quote + 内部 draft 入口），stub 经内部回调把一份 v0 计划交付本仓——
即真实链路除「引擎工作流本身」外的全部环节：租户会话 → 建 campaign → 触发（quote →
一次性 Grant 签发 → 服务身份调引擎）→ job PENDING/RUNNING → 回调落 DRAFT revision →
轮询 SUCCEEDED → 提交审批 → 批准 → 授权签发 → 决策轨迹可查。

运行环境：临时实例 `PORT=14020`（`node dist/main.js`，env 取自本仓 `.env` 覆盖
`ENGINE_ORIGIN`/服务令牌/R4 端口 28447/28448），dev 库 `127.0.0.1:5433/gain_saas`
（已应用迁移 `20261108120000_campaign_plan_job`、`20261108143000_qgo_domain`）。

### 结果（2026-11-08 14:58 本地）

```
E2E_RESULT {"campaignId":"b7f597c4-d22c-4575-9f53-b402e398cb4a",
 "jobId":"02a3ccab-0b6e-415d-98cd-6f9aaf8ef375","jobState":"SUCCEEDED",
 "revisionId":"09c230af-1156-43c9-81e2-5e98111fe110",
 "planHash":"738973875e41bd01ad3baff6274413f1c3fc2caf5601216245deb9cdf33481eb",
 "approvalId":"1fb174b3-c5b5-4ea0-ae99-37107e04c98d",
 "authorizationId":"d4a2dbcb-8308-46a4-822b-5c9b25ed069d","authorizationState":"ISSUED",
 "shadow":true,"traceEntries":4}
```

库侧核对（同一 campaign）：

- `campaign_decision_trace`：4 行（revision.created / revision.submitted / approval.decided / authorization.issued）；
- `audit_log`：campaign.created / campaign.plan_job.created / campaign.revision.created /
  campaign.revision.submitted / campaign.approval.decided 各 1；
- `campaign_plan_job`：`state=SUCCEEDED`，`plan_hash`/`revision_id` 均已回填；
- `campaign_revision`：`state=APPROVED`，`plan_hash` 与 job 行一致（可回放同一计划）。

### 负向/幂等（同一实例实测）

- 重复交付同一 `(jobId, plan_hash)` → `{"idempotent":true,"state":"APPROVED"}`，不新增 revision；
- 缺失 `x-service-token` → 401（服务端点 fail-closed）；
- job 幂等/并发/状态冲突、跨租户 404、失败回写同码幂等在 #75 的单测矩阵内覆盖。

### 影子期口径

授权已签发（ISSUED），但本仓没有任何执行接线（`campaign.*` 事件管道不存在，执行方只能
在 M2.2 出现）；E2E 以「授权存在 + 无执行记录」为结构证据，与设计 D-M2.1-c 一致。

## 2. 未覆盖（待主会话发车后补）

- **引擎真实工作流**：需要引擎 M2.1-1 镜像发车（`gctl switch-backend`）后以 `--live` 重跑
  （同一脚本，去掉 `--stub-engine`，实例需配置真实 `ENGINE_ORIGIN` 与服务令牌），并核对
  引擎侧证据（Temporal 工作流历史 + 模型调用 ai_trace 行）。
- **UI 端到端**：审批卡/Why 卡/影子横幅的真实浏览器操作待 #80 发车后在 4020 验收。
- 平台撤销/授权消费（`uses`）属 M2.2。

## 3. 复现命令（stub 模式）

```bash
# 1) 起始一个隔离实例（示例端口 14020；R4 端口避开在用实例）
cd /global/gain-saas && set -a && source .env && set +a \
  && PORT=14020 HOST=127.0.0.1 ENGINE_ORIGIN=http://127.0.0.1:13999 \
     CAMPAIGN_INTERNAL_SERVICE_TOKEN=e2e-token CAMPAIGN_PLAN_ENGINE_SERVICE_TOKEN=e2e-engine-token \
     R4_TLS_PORT=28447 R4_MTLS_PORT=28448 node apps/server/dist/main.js
# 2) 运行脚本
cd apps/server && BASE_URL=http://127.0.0.1:14020 E2E_EMAIL=owner@demo.cn E2E_PASSWORD=****** \
  CAMPAIGN_INTERNAL_SERVICE_TOKEN=e2e-token CAMPAIGN_PLAN_ENGINE_SERVICE_TOKEN=e2e-engine-token \
  pnpm exec tsx src/scripts/campaign-e2e.ts --stub-engine
```

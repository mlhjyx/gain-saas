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
 "traceEntries":4}
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

## 2. 覆盖情况（2026-11-08 更新）

- ~~引擎真实工作流~~ → **已在 §4 覆盖**：发车（引擎 `e6e579d4`）后以 `--live` 重跑，
  真实 `campaignPlanningWorkflow` 执行并回调落库，引擎 `ai_trace` 行已核对
  （Temporal 原生实例 17233 未挂 UI，以 worker 日志 + 回调 SUCCEEDED 为证）。
- ~~UI 端到端~~ → **已在 §4.1 覆盖**：真实登录会话在 4020 打开 live campaign 详情页，
  断言审批态（已批准）/Why 卡三层/影子横幅文案/零术语红线，共 10 项全部通过并截图归档。
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

## 4. live 模式终验（2026-11-08 17:22 CST，发车后）

发车（引擎镜像 `e6e579d4`，含 M2.1-1 与 DB purpose 迁移修复 #885）后以真实引擎重跑
`campaign-e2e.ts --live`（去掉 stub，脚本同一份）：

```
E2E_RESULT {"campaignId":"f2dcb175-6ab0-4921-9a20-28857d21841d",
 "jobId":"acd6c3a3-eef3-436d-817f-8f389d1e2a9a","jobState":"SUCCEEDED",
 "revisionId":"cbe8e295-5ab1-4aee-8b10-e72e3ddf3529",
 "planHash":"64690352c6297223c7456bdb65b4623921e763676dd8fc5ad5d33edc1fa59a2f",
 "approvalId":"30da0e97-f013-4e81-aedf-d780769c710e",
 "authorizationId":"d3276b1f-0673-46d1-8c79-972da8af2767","authorizationState":"ISSUED",
 "traceEntries":4}
```

> 注：脚本早期版本曾输出硬编码的 `"shadow":true` 字段——它不是可验证的断言（全仓没有
> `CAMPAIGN_EXECUTION_SHADOW` 实现，空真的开关只会制造假安全）。该字段已从脚本删除；
> 影子期口径统一改为**结构证明**（见 §4.2）。

真实引擎工作流（`campaign-plan-acd6c3a3-…`，customer worker @ 原生 Temporal 17233）完成：
触发（quote → 一次性 Grant → 服务身份调引擎 draft）→ 装配输入 → `campaign.plan` 模型调用
（ai_trace：`deepseek-flash` OK，7.5s）→ 回调落 DRAFT revision → 提交 → 批准 → 授权签发。

两侧落表核对（同一 campaign）：

- gain-saas `campaign_decision_trace`：4 行（revision.created[service] / approval.submitted[user] /
  approval.decided[user] / authorization.issued[service]）；
- `audit_log`：campaign.created / plan_job.created / revision.created / revision.submitted /
  approval.decided 各 1；
- `campaign_plan_job`：SUCCEEDED，plan_hash/revision_id 已回填，与 revision 行一致（APPROVED）；
- `campaign_execution_authorization`：ISSUED，TTL 30 分钟，uses 0/1；
- 引擎 `ai_trace`：`task='campaign.plan'` OK 行 1 条（deepseek-flash）；此前 `gpt-5.6-sol` 的
  ERROR 行对应下述外部故障期。

负向/幂等（同一实例实测）：重复交付 `(jobId, plan_hash)` → `idempotent:true` 不新增 revision；
缺 `x-service-token` → 401。

### 4.1 浏览器端到端断言（真实登录会话 @ 4020，2026-11-08 17:51 CST）

对 live campaign `f2dcb175-…` 在已部署 SPA（4020）执行真实浏览器操作（Playwright + 系统
Chrome；先经登录表单建立 Cookie 会话，再打开 `/campaigns/:id`），10 项断言全部通过：

| # | 断言 | 结果 |
| --- | --- | --- |
| 1 | 真实登录会话建立（表单登录 → `/workspace`） | ✅ |
| 2 | 详情页渲染该 live campaign | ✅ |
| 3 | 影子横幅文案「影子期：批准不会真的执行；我们只记录决策与指标。」 | ✅ |
| 4 | 版本时间线 = 第 1 版 · 已批准 | ✅ |
| 5 | 已批准态不再出现待审批卡 | ✅ |
| 6 | Why 卡标题「为什么这样计划」 | ✅ |
| 7 | 零术语红线：默认视图无 `plan_hash` | ✅ |
| 8 | 零术语红线：默认视图无 campaign UUID | ✅ |
| 9 | Why 卡第二层「依据」展开含规模/预算 | ✅ |
| 10 | Why 卡第三层「技术详情」展开含「计划版本 · 64690352…」（#85 零术语改名后的标签） | ✅ |

截图：[assets/campaign-planner-live-detail.png](assets/campaign-planner-live-detail.png)
（详情页全页，含影子横幅、计划摘要、Why 卡三层与版本时间线）。

### 4.2 影子期口径：结构证明（无调用路径）

v0 不交付任何执行接线，审批通过只签发 ExecutionAuthorization（业务动作边界凭据）；系统内
不存在消费该授权去执行动作的代码路径。该事实由源码级单测钉住
（`apps/server/src/campaign/campaign-execution-wiring.absence.spec.ts`，设计 §8-1）：

- `campaignExecutionAuthorization` 仅被 `campaign.service.ts`（签发/撤销/校验）与
  `ops.service.ts`（workspace 停用联动撤销，置 REVOKED）引用，模块外无人消费；
- `verifyAuthorization` 的唯一调用方是只读的 `/api/internal/v1/execution-authorizations/verify`；
- campaign 模块唯一的出网客户端只调用引擎 draft 端点（`/api/v1/internal/campaign-plans/draft`）；
- 生产源码不含 `CAMPAIGN_EXECUTION_SHADOW` 引用——空真的开关是假安全，M2.2 接入执行方时
  必须实现该闸门（默认 on）并把本节断言替换为闸门行为测试。

### 终验过程中修复/绕过的问题（均为环境层，代码未变）

1. **引擎 DB 契约缺迁移**：首轮 live 在消费 Grant 时报 `EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE`
   ——`execution_budget_purpose` 是 Postgres ENUM，且 kind-shape CHECK 与
   `consume_workspace_execution_authority` 各有白名单；M2.1-1 只改了 TS 枚举。修复
   mlhjyx/global-backend#885（两段式 forward-only 迁移），随镜像 `e6e579d4` 应用。
2. **推理档上游故障**：`gpt-5.6-sol`（中转 tbtk.cc:9933）自 08:19 UTC 整站不可达，
   new-api channel #3 持续 500；影响所有推理档任务（同期 `discovery.query_plan` 同挂）。
   故障期经 `MODEL_ACQUISITION_TASK_MODELS` 降档 `campaign.plan → deepseek-flash` 完成终验
   （上游恢复后删除覆盖、恢复推理档）。

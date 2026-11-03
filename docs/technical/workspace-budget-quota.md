# workspace 累计预算/配额（拒绝钱包攻击）

> 文档 ID：`DOC-TECH-WORKSPACE-BUDGET-QUOTA-001`
> 生命周期：`CURRENT`
> 最后核验：2026-11-04

签发一次性执行预算 Grant 之前的累计配额检查。产品负责人 2026-11-04 拍板：新注册 workspace 滚动 30 天 **30 次 run / 15 USD**；存量 workspace 全部豁免。

## 为什么放在 SaaS 签发端

引擎的 workspace Grant 合同（`execution-budget-authority.types.ts` 的 `assertAuthorityPurposeShape`）强制 `campaignCapMicrousd === null && maxRuns === null`——这两个字段只属于平台 Grant。把累计额度塞进 Grant 需要跨仓改签名合同、改引擎验证器并发镜像。而 Grant 只能由 gain-saas 签发（引擎验签后执行），签发端就是唯一的收费闸门，因此在签发前检查等价且成本低一个量级。引擎侧 defense-in-depth 留作后续任务。

## 实现

- 表 `workspace_budget_policy`（迁移 `20261104050000_workspace_budget_policy`）：`workspace_id` 主键、`window_days`（默认 30）、`max_runs`、`max_spend_micros`、`enabled`、`updated_by`。迁移把存量 workspace seed 为 `enabled=false`；新 workspace 首次签发时懒创建，按 env 默认值启用。
- `WorkspaceBudgetPolicyService`（`apps/server/src/bff/`）：在同一事务里 upsert policy → `SELECT … FOR UPDATE` 锁行（同一 workspace 的签发串行化）→ 现算窗口内 `discovery_run_link` 计数与 `cost_ledger` 花费。`discovery.run` 的签发要求 `已用 run + 1 ≤ max_runs`；花费达到 `max_spend_micros` 时拒绝所有付费 Grant。
- 超限抛 `WorkspaceBudgetQuotaExceededError`（HTTP 402，`WORKSPACE_BUDGET_EXCEEDED`，details 带窗口/上限/已用量）；BFF 与注册引导端点原样透传，前端沿用现有错误提示。
- 开关：`WORKSPACE_QUOTA_ENFORCE=false` 时只记录日志不拒绝；额度用 env（`WORKSPACE_QUOTA_*`）或直接改 policy 行调整。

## 已知边界

- `cost_ledger` 是结算后写入，花费检查存在滞后；run 次数是硬闸（`discovery_run_link` 在 run 发起时即写入）。
- 花费依赖事件消费开启（`EVENT_CONSUMER_ENABLED=true` 时事件消费者把结算写进 `cost_ledger`）；消费者关闭时只有 run 次数上限生效。
- 现有注册/邀请与 ops 登录限流已在 Phase 1a 落库（gain-saas #30），不在本项范围。

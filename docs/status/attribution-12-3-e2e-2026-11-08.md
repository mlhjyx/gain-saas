# M2 步 12-3 · 归因闭环正式联调（2026-11-08）

> 生命周期：`EVIDENCE`
> 依据：计划 v1.5 步 12（能力 5：Outcome→归因→单位经济）与设计 `mlhjyx/global-backend:docs/superpowers/plans/2026-11-08-opportunity-attribution-m2-step12.md`（APPROVED，D-12-a~e）。
> 代码：本仓 12-1/12-2（#82）、12-3 预演（#89）、对账口径修复（#94）；11-x 发送/回复链路（#104/#106/#107，m1-5 线）。

## 1. 联调口径

用 11-x 沙箱全链（本机 SMTP sink，TEST 标签）产生的**真实回复数据**替换此前手工登记的
REPLIED 来源，验证「商机 → 发送 → 回复 → outcome → 归因」全链：

1. **发送链路有料**：`outreach_batch` / `outreach_draft` / `outreach_send` 存在（批次已审批、sink 已投递）；
2. **回复有料**：`outreach_reply(kind=REPLY)` 存在；回复经 `engage.reply_classify` 分类后
   回写 `opportunity_outcome(outcome='REPLIED', source='SYSTEM', sourceEventId=…)`；
3. **归因口径（不变）**：目标 campaign 的 `replyCount` = 该 campaign 下含 REPLIED outcome 的
   **distinct SAO** 数（弱信号按 SAO 去重，多条回复不放大）；positive/negative 分母口径不变；
4. **对账规则（不变）**：`balanced` 按「任一行 diff≠0 → false」判定；plan 侧 v0 占位差异
   （引擎 usage_ledger 已计入、视图 plan_cost=0）如实显示为差异，脚本不误判通过。

## 2. 运行

只读，针对 dev 两库（SaaS 库 `DATABASE_URL` + 引擎库 `OPS_APP_DATABASE_URL`）：

```bash
pnpm --filter @gain-saas/server exec tsx src/scripts/attribution-12-3-live.ts <workspaceId> <campaignId>
```

输出 JSON：`outreach_*` 分组计数、REPLIED outcome 的 source 分布、归因行、对账明细、
`passed`。退出码 0 = 结构断言通过；2 = 结构断言失败。

## 3. 结果（待 m1-5 沙箱数据就绪后填）

> 占位：运行上述命令后贴 `checks`/`funnel`/`reconciliation` 摘要。

## 4. 已备好的预演回归（不依赖沙箱）

`apps/server/src/ops/ops-attribution.e2e.test.ts`（一次性真库 + 真实 Campaign/QGO 服务）：
- 战役→审批→授权→商机→accept→outcome→归因，并对账 1,500,000 µUSD 一分不差；
- **系统回写 REPLIED 用例（本 PR 新增）**：同一 SAO 重放 SYSTEM REPLIED 不放大
  `replyCount`；新 SAO 仅系统回写 REPLIED 时 `replyCount+1`；positive/negative 不受影响；
- `debug` 定界：REPLIED 目前以 outcome 为 SoR；若 11-x 后续新增回复原始表与 outcome 的
  对账，可在此文档追加一节。

## 5. 边界

- `outreach_reply` 与 `opportunity_outcome` 的桥接（分类回写 REPLIED）由 11-x/m1-5 线提供；
  本线只消费 outcome 并断言归因口径，不改 11-x 代码。
- plan 成本 v0 占位：对账红是**预期**信号，直至 M2.1 计划成本进入视图口径。

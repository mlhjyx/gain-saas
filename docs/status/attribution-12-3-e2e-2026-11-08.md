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

## 3. 结果（2026-11-08 执行；沙箱数据为 m1-5 当日 12:34 演示）

数据现场（dev 部署库只读核对）：workspace `5a725465-507c-460b-87bb-c9619c7e9285`

- `outreach_batch` 5（QUEUED 1 / SENT 1 / COMPLETED 3）；`outreach_draft` 6（APPROVED 1 /
  SENT 2 / SKIPPED 3）；`outreach_send` 5（SENT 2 / SKIPPED 3）；`outreach_reply` 1
  （kind=REPLY，classification=NEGATIVE，contactRef 为联系人 UUID）；`outreach_audit_package` 9。
- **全部 5 个 batch 的 `campaign_id` 为 NULL；该 workspace 没有任何 campaign / qgo / sao 行，
  也没有任何 opportunity_outcome。**

断言输出（`pnpm exec tsx src/scripts/attribution-12-3-live.ts 5a725465-…`，退出码 2）：

| 断言 | 结果 | 证据 |
| --- | --- | --- |
| outreach_batch / draft / send / reply 有料 | ✅ ×4 | 计数同上 |
| opportunity_outcome REPLIED（回复弱信号回写） | ❌ | 0 行（bySource 空，distinct SAO 0） |
| campaign 归因行 | ❌ | workspace 无 campaign；漏斗 campaigns=0 |
| 对账规则 | 未触发 | 无 campaign 行可对，**不是绿灯**（见 §5） |

**结论（真实缺口，不是数据没跑）**：链断在两处，均在 11-x 数据侧；12-x 侧器材（视图、
归因服务、本脚本、预演 e2e）已就绪（§4）。

1. **回复→outcome 接缝缺失**：11-x 当前实现回复只写 `outreach_reply` + `outreach_consent`，
   **不回写 `opportunity_outcome`**（m1-5 2026-11-08 交叉确认）。`outreach_reply`/`outreach_draft`
   只有 contactRef，batch 只带 campaignId，而 QGO 侧只有 leadRef（无 contactRef 列），
   contactRef→leadRef 无现成映射——不能靠隐式映射补齐。已与 m1-5 对齐推荐方案：reply API
   携带可选 `saoId`，`engage.reply_classify` 回写
   `opportunity_outcome(outcome='REPLIED', source='SYSTEM', sourceEventId=reply.id, saoId=…)`；
   12-3 断言只依赖 outcome 挂对 SAO（其 `qgo.campaignId` = 目标 campaign），不需要 contactRef 映射。
2. **沙箱演示未挂战役商机**：重跑演示需先具备 campaign→审批→授权→QGO→SAO（12-1 链路），
   batch 带 campaignId，回复落到该 campaign 下 SAO 的 outcome。

上述两处接通后重跑本命令即应退出 0；对账差异仍按既有口径如实报告（plan v0 占位差异属预期）。

### 3.1 正式收口（2026-11-08 部署后复跑，8/8 通过）

- **前提落地**：G5（reply→outcome SYSTEM 回写，PR #115，main `71afd55`）已并入 main 并随本批
  补发上线（gain-saas web/worker 于 20:47:06 CST 重启，晚于 #115 合并 12:45:54Z）；引擎侧同批
  切到 5c969c33（digest 902b41ff）。
- **fixture**（m1-5 部署库重跑，长期保留在 dev）：workspace `5c47d7fd` / campaign `9a67796e`
  （M2 11-4 Demo Campaign，DRAFT）/ SAO `7920ddd6`；batch 5 / draft 6（APPROVED 1、SENT 2、
  SKIPPED 3）/ send 5（SENT 2、SKIPPED 3）/ reply 1（REPLY/NEGATIVE，`478469f6`）/
  audit package 12。
- **复跑结果**：`attribution-12-3-live.ts 5c47d7fd… 9a67796e…` → **8/8 全过，退出码 0**：
  - REPLIED outcome 1 条：source=SYSTEM，`source_event_id = reply.id`，挂 SAO `7920ddd6`；
  - 归因视图：qgo=1 / sao=1 / replyCount=1 = distinct SAO(REPLIED) 1；positive/negative=0
    （fixture 无对应 outcome）；
  - 对账：balanced=true，无差异行。
- **两跑对照与口径说明**：G5 前首跑（早期 workspace `5a725465`，无 campaign、无 outcome）
  退出 2、断点如实入档（§3）；fixture 的 reply/outcome 行产生于部署前 12:41:29（G5 分支代码经
  API 写入，与部署代码一致），本次正式跑为只读断言，验证数据链→视图→对账口径；部署后写路径
  本身由 11-x 用例（17/17 PASS）覆盖，12-3 不重复写数据。
- **对账为何平衡**：fixture campaign 为 DRAFT 且无 execution authorization，exec/plan 成本为 0，
  无 plan v0 占位差异可对；与「diff≠0 → balanced=false」规则不冲突，属口径内为真的绿灯。
- 早期 workspace `5a725465` 无 campaign，仅作 G5 前对照，勿复用。

## 4. 已备好的预演回归（不依赖沙箱）

`apps/server/src/ops/ops-attribution.e2e.test.ts`（一次性真库 + 真实 Campaign/QGO 服务）：
- 战役→审批→授权→商机→accept→outcome→归因，并对账 1,500,000 µUSD 一分不差；
- **系统回写 REPLIED 用例（本 PR 新增）**：同一 SAO 重放 SYSTEM REPLIED 不放大
  `replyCount`；新 SAO 仅系统回写 REPLIED 时 `replyCount+1`；positive/negative 不受影响；
- `debug` 定界：REPLIED 目前以 outcome 为 SoR；若 11-x 后续新增回复原始表与 outcome 的
  对账，可在此文档追加一节。

## 5. 边界

- `outreach_reply` 与 `opportunity_outcome` 的桥接（分类回写 REPLIED）由 11-x/m1-5 线提供；
  本线只消费 outcome 并断言归因口径，不改 11-x 代码。接缝缺口已由 G5（#115）修复并入部署，
  正式收口结果见 §3.1。
- plan 成本 v0 占位：对账红是**预期**信号，直至 M2.1 计划成本进入视图口径。

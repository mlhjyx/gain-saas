# P4 发送门 v1 证据（ch05 P4-01 / P4-02 服务层 / P4-03 消费侧，2026-11-09）

分支：`claude/outreach-gate`（PR #121）
范围：把「法域同意、执行授权、频率/窗口/额度、退信投诉熔断」变成发送路径上的强制校验。
不部署、不发真实邮件：`OUTREACH_SEND_ENABLED` 默认关，`CAMPAIGN_EXECUTION_SHADOW` 默认 on（真正只读）。

## 交付清单

| 能力 | 实现 | 验证 |
| --- | --- | --- |
| 法域同意门进发送路径 | `outreach-jurisdiction.ts`：DE/AT 无 `OPT_IN` 拒发；US 需物理地址页脚；FR 需来源告知页脚；未知国家 `REVIEW_REQUIRED`（fail-closed）。`outreach_draft.country_code`（迁移加列） | `outreach-jurisdiction.spec.ts` 12 例（三法域正负/大小写/未知国家）；发送服务集成 6 例 |
| ExecutionAuthorization v2 只读消费 | `outreach-authorization.consumer.ts`：校验 batchId/内容哈希/收件人集合哈希/草稿集哈希/caps/schedule/budget/jurisdiction/剩余 uses；逐封消费 `outreach_send.authorization_use`；重试沿用首次序号（按 authorizationId 隔离）；中途过期复查 | `outreach-authorization.consumer.spec.ts` 21 例（过期/撤销/v1 scope/错批次/内容或收件人变化/窗口/预算/国家越界/uses 耗尽/改绑新授权/跨切片） |
| 控制面 v1（服务层） | `outreach-send-controls.ts`：信箱日/周上限、收件人当地窗口（IANA 时区、DST 安全）、同收件域 ≤5/小时、退信/投诉滚动 7 天熔断；**逐封发送循环内评估，计数随本批已发递进**；授权 caps 作为上界收紧 env | `outreach-send-controls.spec.ts` 16 例（DST 边界、递进、熔断最小样本、caps 收紧）；发送服务集成 6 例（含单批内第 30 封后顺延、第 5 封/域后顺延） |
| 影子模式 | `CAMPAIGN_EXECUTION_SHADOW` 默认 on、fail-safe 解析（仅显式 `false` 关闭）；不投递/不消费授权/不写台账/不改草稿状态，只记 `SEND_SHADOWED`（含 wouldSkip） | 发送服务 2 例（正常影子和「会跳过的草稿不被烧掉」） |
| 结构化审计 | `BATCH_REJECTED`/`DRAFT_SKIPPED`/`DRAFT_DEFERRED`/`SEND_SHADOWED` 事件含 actor/批次/原因码/国家/法域策略；审计包新增 authorizationId、countryCode、jurisdictionPolicy、逐封授权消费；门拒绝保留人话原因 | 发送服务断言 3 例；审计包用例 |
| 错误文案 | 18 个新错误码登记进 `packages/shared/src/errors.ts`（中英三层） | `errors.test.ts` 新用例 |

## 本机验证记录

```
apps/server 全量：70 files / 500 tests 全绿（vitest run）
类型检查：tsc -p tsconfig.json --noEmit 绿
零术语：pnpm lint:terms 绿
迁移：一次性库 prisma migrate deploy 全链通过（含 20261109120000_outreach_p4_send_gate_v1；additive，无回填）
```

## 门序（批次级整批拒绝 vs 逐封）

批次级（任一不满足 → 409/503，SMTP 0 调用）：总开关 → 批次状态 → 审批与内容哈希 →
逐封已批准 → 单批规模（建草稿/提交时拦截 ≤50）→ SMTP 配置 → 执行授权 v2 → 退信/投诉熔断。
逐封级（只影响该封）：法域同意 / DNC → `SKIPPED`（写台账、事件含国家与原因码）并继续其余封；
窗口 / 限速 / 额度 → `DEFERRED`（不写失败台账、不消费授权，草稿保持待发）。

## 不能证明什么

- **授权签发/绑定侧不在本 PR**：没有任何代码路径写 `outreach_batch.authorization_id`，也无 v2 签发方。
  真实发送（含影子演练）都会 409 fail-closed——这是设计的前置，不是本 PR 的运行时证据。
- 未连接真实 SMTP/收件方：进箱率、SPF/DKIM/DMARC、真实退信/投诉数据属域名与 warmup 上线后的验收（E5-01/02/03）。
- 熔断的恢复流程、跨进程并发发送防护（`inFlight` 为进程内锁）、收件人级时区（当前按国家默认时区）分别为 P4-08、P4-04、P4-02 完整版的交付。
- 只读 eligibility API 不复检 US/FR 页脚配置（它只回答同意/法域策略），因此可能出现「API 显示可发、发送时因缺页脚配置跳过」的差异；页脚配置属运营配置项。

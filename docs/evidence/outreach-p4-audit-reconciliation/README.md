# P4 第七波：审计包扩展与日对账（P4-14 工程部分，2026-11-10）

分支：`claude/p4-14-audit`。这是 P4-14 中**不依赖发车环境**的工程部分：审计包补齐授权/信箱/种子/熔断快照，
新增台账日对账（端点 + 默认关闭的日 worker）。不部署、不发真实邮件、无 schema 变更。

## 交付清单

| 能力 | 实现 | 验证 |
| --- | --- | --- |
| 审计包扩展 | `outreach_audit_package` 新增：`authorization`（id + 已消费 uses）、`mailbox`（地址/warmup 阶梯/state/日周上限）、`seedTest`（该发件域最近一次种子测试）、`health.breakers`（当前熔断器快照）、`jurisdictionPolicyVersion`；逐封 `authorizationId/authorizationUse` 此前已在 | `outreach-send.service.spec.ts`（逐封发送成功用例扩展断言）；packageHash 仍内容寻址（新增字段参与哈希） |
| 日对账 | `GET /api/outreach/reconciliation?date=YYYY-MM-DD`：核对台账×草稿状态×授权消费×消息 id×同日重复发送，缺口逐条列出（7 类闭集码），`ok=false` 即存在缺口 | `outreach-reconciliation.service.spec.ts` 5 例（干净日/四类缺口/草稿无账/重复发送/SKIPPED 无因/租户与日期隔离） |
| 日 worker | `OUTREACH_RECONCILE_ENABLED` 默认 false、间隔默认 24h；遍历有信箱的 workspace 对账「昨天」并写审计 | 启动守卫同既有 worker 模式；服务层已测 |
| 口径限制 | 响应 `limitations` 明示：只核对本系统台账内部勾稽；信箱服务商/供应商侧已发送数属发车后 E5-12 外部半边 | — |

## 本机验证

```
apps/server outreach+campaign：36 files / 295 tests 绿
tsc --noEmit 绿；packages/shared 39 tests 绿
迁移：一次性库 prisma migrate deploy 全链回归通过（本波无新迁移）
```

## 对账码（闭集）

`SENT_WITHOUT_MESSAGE_ID` / `SEND_WITHOUT_AUTHORIZATION_USE` / `DRAFT_MISSING` /
`LEDGER_SENT_DRAFT_NOT_SENT` / `DRAFT_SENT_WITHOUT_LEDGER` / `DUPLICATE_SENT_ATTEMPTS` / `SKIPPED_WITHOUT_REASON`

## 不能证明什么

- 外部半边未接：SMTP 服务商/信箱的「已发送数」与供应商回执需要真实收发凭据，发车后按日对账验收（E5-12 全量口径）。
- 审计包新增字段改变了 packageHash（内容寻址按版本区分，旧包保留可复算）；这不是破坏性变更。

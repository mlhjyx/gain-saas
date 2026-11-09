# P4 第六波：授权签发/绑定（P4-03 签发侧，2026-11-10）

分支：`claude/outreach-authz-issue`。这是 P4-13 端到端联调的**唯一工程硬前置**：在此之前，
执行器要求批次绑定 `campaign-authz/v2` 授权，但仓库里没有任何代码会签发或绑定它。
不部署、不发真实邮件；默认不自动签发。

## 交付清单

| 能力 | 实现 | 验证 |
| --- | --- | --- |
| v2 授权签发 | `CampaignModule` 新增 `OutreachAuthorizationIssuer.issue(tenant, batchId)`：只读已批准批次事实（QUEUED + APPROVED 审批 + 内容哈希一致），派生 scope：batchId / 收件人集合哈希 / 草稿集哈希 / caps（env 上界）/ schedule（默认 7 天窗口）/ budget（收件人数 × 单价）/ jurisdiction（草稿国家集）；`maxUses=收件人数`；`expiresAt=min(TTL, notAfter)`；无 campaign 的独立批次用批次自身承载 claims | `outreach-authorization.issuer.spec.ts` 5 例（含**签发→消费端到端**：签发产物直接喂给 `OutreachAuthorizationConsumer.authorizeBatch` 通过） |
| 批次绑定 | 同一事务内写 `outreach_batch.authorization_id` + `AUTHORIZATION_ISSUED` 批次事件；已绑定未过期 ISSUED 授权时幂等返回；REVOKED/过期则重新签发并改绑 | 同上（幂等/改绑用例） |
| 触发方式 | 默认 **不自动签发**（`OUTREACH_AUTHORIZATION_AUTO_ISSUE=false`）；管理员端点 `POST /api/outreach/batches/:batchId/authorize`；可选开关开启后审批即签发（失败只落 `AUTHORIZATION_ISSUE_FAILED` 事件、不回滚审批） | issuer spec + batch service spec（开关关/开、失败不回滚） |
| 签发对端校验 | 内部 verify 端点（`POST /api/internal/v1/execution-authorizations/verify`）支持 v2：按 `action.batchId` 与 scope.actions[].batchId 匹配；v1 的 icpIds 子集校验不变；请求体允许 `batchId` | `campaign-verify-v2.spec.ts` 3 例（v2 匹配/负向/v1 回归） |
| 哈希同构 | `hashOutreachAudience` / `hashOutreachDraftSet` 移入 `outreach-content.ts`，签发端与消费端共用一份实现（消费者保留再导出） | 签发→消费端到端用例即证据 |
| 配置 | `OUTREACH_AUTHORIZATION_AUTO_ISSUE=false`、`OUTREACH_AUTHZ_TTL_MINUTES=10080`、`OUTREACH_AUTHZ_SCHEDULE_DAYS=7` | — |

## 本机验证

```
apps/server outreach+campaign：33 files / 277 tests 绿
tsc --noEmit 绿；packages/shared 39 tests 绿
迁移：一次性库 prisma migrate deploy 全链通过（本波无新迁移，回归验证）
```

## 语义与边界

- **签发 ≠ 发送**：批次获得授权后，发送仍需 `OUTREACH_SEND_ENABLED=true`、影子关闭、执法器全部逐封门通过。
- 授权 TTL 默认 7 天且不超过计划窗口 `notAfter`——解决「顺延后重试遇授权过期」问题（签发侧口径）。
- 无 campaign 批次：claims/行里的 campaignId 用批次自身承载（消费端按 DB 行 + scope.batchId 校验，不依赖 campaign 链）。
- `ops-attribution` 的授权 scope 解析仍只认 v1 `actions[].icpIds`（v2 授权在该报表归零）；这是既有已知项，随
  campaign 级成本归因卡片一并扩展，不影响签署/发送链路。

## 不能证明什么

- 没有真实发送：签发→发送端到端要等发送开关与授权之外的其余发车门槛（域名/warmup/发车授权）。
- v2 授权在引擎侧（backend）无消费者——引擎不参与发信（D5-5），内部 verify 端点供其只读核对。

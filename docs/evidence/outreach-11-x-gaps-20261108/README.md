# 11-x 缺口修复证据（13-1 + 12-3 联调，2026-11-08）

分支：`claude/outreach-dnc-fail-closed`（PR #113）
范围：G1 DNC fail-open、G3 审计包内容寻址、G4 门拒绝留痕、G5 回复→outcome 接缝。
G2（平台抑制端点 404）由 backend #896 + gain-saas #110 修复，部署后复验（见文末）。

## 修复清单

| 缺口 | 修复 | 验证 |
| --- | --- | --- |
| G1 DNC 403/5xx 被当成无命中 | `EngineOutreachDncChecker.check` 非 2xx、缺 `data.results`、缺条目/畸形条目均抛错；send 层 503 `OUTREACH_DNC_UNAVAILABLE` | 单测 6 例（403/503/缺 results/缺条目/畸形/正常）；outreach 46/46 |
| G3 `packageHash` 含 `generatedAt`，`persistedAt` 恒空 | 哈希只覆盖事实（排除 `generatedAt`） | 单测重复读取同一 `packageHash` 且 `persistedAt != null`；live 演示审计包步骤含 `persistedAt` |
| G4 门拒绝无工件 | 拒绝前写 `BATCH_REJECTED` + 持久化审计包 + `audit.record` | 单测：过期批准被拒后事件/包存在、`outreach_send` 为 0 |
| G5 回复→outcome 缺失 | reply API 可选 `saoId`；REPLY 写 `opportunity_outcome(REPLIED, SYSTEM, sourceEventId=reply.id)`，按 `(saoId, sourceEventId)` 幂等；SAO 必须属于当前 workspace | 单测 3 例；live 演示 outcome 步骤 + 12-3 脚本退出 0 |
| G2 suppress 404 | backend #896（`POST /outreach/dnc/suppress`，`x-service-token`）+ gain #110（`OUTREACH_ENGINE_SERVICE_TOKEN`） | 待部署后复验；未配置时租户内退订仍生效，跨租户同步 warn-only |

## 部署库沙箱演示（TEST-ONLY）

- 数据库：部署库 `gain_saas`（本机 5433），Mailpit `127.0.0.1:11025/18025`，`.test` 域
- workspace：`5c47d7fd-f5ee-4c1f-969b-a7a4c744b591`
- campaign：`9a67796e-92ae-4836-bb89-8bf8826ab32c`
- SAO：`7920ddd6-8235-47cc-be13-3485ea1750f4`
- 结果：`e2e-live-demo.json`，17/17 PASS；Mailpit 收到 2 封（A1/A2）
- 关键断言：未批准直发拒、DKIM 签名、List-Unsubscribe、退订 token 生效、
  OPT_OUT 后跳过、回复分类回写、`opportunity_outcome.REPLIED`、DNC 命中跳过、
  DNC 查询失败 fail closed、重放拒绝、审计包 `persistedAt` 非空。

## 12-3 只读断言

`attribution-12-3-live.ts` 对上述 workspace/campaign 运行，退出码 0（`attribution-12-3-live.json`）：

```
"replyCount": 1,
"name": "归因 replyCount == distinct SAO(REPLIED)",
"ok": true,
"distinctRepliedSao": 1
"balanced": true
"passed": true
```

## 不能证明什么

- G1 的 403 分支由单测 stub 证明；live 演示的 DNC 是注入 stub（真实引擎 200 路径由 11-1 覆盖）。
- G2 真实跨租户写入需部署 backend #896 与 gain #110，并设置两处同名服务令牌后复验。
- 真实收件方 SPF/DKIM/DMARC 与进箱率仍属 11-5。

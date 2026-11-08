# P4 第二波 A：发件资产/配额落库与发送遥测回灌（2026-11-09）

分支：`claude/outreach-gate`（同 PR 由主会话复核）。承接 ch05 P4-02 完整版与 P4-04 遥测部分：
把 env + 台账回读的「单信箱降级模式」升级为 **资产表 + 计数表**，并让 SMTP 结果即时回灌熔断窗口。
发送总开关默认关、影子默认开；不发真实邮件、不部署。

## 交付清单

| 能力 | 实现 | 验证 |
| --- | --- | --- |
| 发件资产表 | `outreach_domain` / `outreach_mailbox`（warmupStage W1–MATURE、state、日/周上限、lastSendAt、healthState） | `outreach-mailbox.service.spec.ts` 10 例 |
| 配额计数落库 | `outreach_mailbox_counter`（日，sent/hardBounces/complaints）/ `outreach_domain_counter`（发件域×收件域×小时）；发送成功后原子 upsert 递增 | 同上 + 发送服务集成（成功一封后计数 1/1） |
| 控制面接资产 | 生效上限 = min(env, 信箱资产, 授权 caps)；日/周用量 = max(计数表, 台账存量)；信箱 state≠ACTIVE → 整批 `OUTREACH_MAILBOX_PAUSED` | 控制面 17 例 + 发送服务「PAUSED 整批停发」 |
| 发送遥测 | `outreach_send.smtp_status_code/smtp_response/bounce_type/latency_ms`；5xx→HARD、4xx/超时/网络→SOFT；HARD 写 `SEND_HARD_REJECTED` 事件与信箱硬退计数 | 发送服务 2 例（550 硬拒 / 超时 SOFT） |
| 遥测回灌熔断 | 退信率分子 = DSN 退信 + SMTP 硬拒，分母 = 已发送 + 硬拒；发送时即落台账，不等 DSN | 控制面「6 硬拒/106 触发熔断」 |
| 种子测试记录 | `outreach_seed_test` + `GET/POST /api/outreach/seed-tests`（provider/百分比/reportRef/contentHash 校验） | `outreach-seed-test.service.spec.ts` 3 例 |
| 管理端点 | `GET/POST/PATCH /api/outreach/mailboxes`、`GET /api/outreach/mailboxes/usage`（默认信箱 + 用量 + 阶梯上限） | 服务层 10 例（控制器为薄封装） |
| 错误文案 | `OUTREACH_MAILBOX_NOT_FOUND` / `OUTREACH_MAILBOX_DUPLICATE` / `OUTREACH_DOMAIN_NOT_FOUND` 登记中英三层 | `errors.test.ts` 列表 |

## 本机验证

```
apps/server outreach+campaign：13 files / 147 tests 绿（vitest）
tsc -p tsconfig.json --noEmit 绿
packages/shared：3 files / 19 tests 绿
迁移：一次性库 prisma migrate deploy 全链通过（20261109180000_outreach_p4_assets_telemetry，additive）
```

## 不能证明什么

- 计数表的多进程并发正确性：日/周 upsert 是原子的，但「检查-发送-计数」整体仍需 P4-04 的批次 advisory lock；当前部署单实例。
- 真实 SMTP 遥测分布（5xx/4xx 比例）需要真实发信后才会有数据；本 PR 只证明分类与落账路径。
- DSN/ARF 回灌（异步退信与投诉）属第二波 B 的 ingest；本 PR 的投诉熔断仍依赖 `outreach_reply` 的 COMPLAINT 录入。
- warmup 自动升阶与「连续两周种子不达标暂停该域」的判定不在本 PR（清单消费在运营台/后续卡片）。

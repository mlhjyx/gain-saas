# P4-15 真实 SMTP 端到端验收（本地 GreenMail，零费用，2026-11-09）

分支：`claude/p4-15-smtp-live`。此前的验收覆盖：发送门/控制面/熔断/台账有单测，#139 做过 IMAP 协议级验收；
**缺的是「发送执行器 → 真实 SMTP 投递 → 收件箱核对 → 回信归因 → 回复即停」的整链**。本波用本地免费
GreenMail 容器补齐，并因此抓到并修复一个会在生产导致「回复即停」失效的真实缺陷。

## 真实缺陷：Message-ID 与台账不一致（回信无法归因）

- **现象**：`SmtpOutreachTransport.send()` 返回并落库的 `outreach_send.messageId` 是**裸 UUID**，
  而实际发出的 `Message-ID` 头是 `<uuid@发件域>`（`buildMimeMessage` 内部拼了 `@domain`）。
- **后果**：真实收件人回复的 `In-Reply-To` 是 `uuid@发件域`，与台账里的裸 UUID 永不相等 →
  ingest 归因失败 → OPT_OUT 不写入 → **「回复即停」在生产永远不触发**。#139 的 IMAP 验收用手工夹具
  （messageId 恰好带 `@example.test`）所以没暴露。
- **修复**：传输返回与线上头同形的完整 id（`uuid@fromDomain`），`buildMimeMessage` 不再重复拼域；
  单测新增「台账值必须等于线上 Message-ID 头」的回归断言。

## 验收结果（15/15 PASS，exit 0）

| # | 检查 | 结果 |
| --- | --- | --- |
| 1 | 真实投递 1 封（DE 有 OPT_IN）、法域门跳过 1 封、0 失败 | PASS |
| 2 | 跳过码 = `JURISDICTION_CONSENT_REQUIRED` | PASS |
| 3 | GreenMail：A 收件箱 +1、B 无新增 | PASS |
| 4 | 主题一致、正文含退订页脚、头部带 `List-Unsubscribe` | PASS |
| 5 | DKIM 签名（d=example.test, s=acceptance，relaxed/rsa-sha256） | PASS |
| 6 | 台账 SENT：`smtpStatusCode=250`、`latencyMs`、`authorizationUse=1`、messageId 含 `@` | PASS |
| 7 | 执行授权 v2 逐封消费 `uses=1` | PASS |
| 8 | 状态机：草稿 SENT/SKIPPED、批次 COMPLETED | PASS |
| 9 | 审计包内容寻址 `packageHash` 落库 | PASS |
| 10 | 计数落库：信箱日计数=1、同收件域小时计数=1 | PASS |
| 11 | IMAP 轮询处理 1 封回复 | PASS |
| 12 | 归因：`outreach_reply` kind=REPLY 且关联联系人 | PASS |
| 13 | 回复即停：email `OPT_OUT`（source=reply:reply） | PASS |
| 14 | 停发后新批次 0 投递（`OUTREACH_OPTED_OUT`）、收件箱无新增 | PASS |
| 15 | 重复发送拒绝（`OUTREACH_BATCH_ALREADY_COMPLETED`）且无新台账 | PASS |

## 运行方式

```bash
# GreenMail（仅回环端口；standalone 默认已含 auth.disabled 与 setup.test.all）
docker --context default run -d --rm --name greenmail-smtp-check \
  -p 127.0.0.1:3465:3465 -p 127.0.0.1:3993:3993 greenmail/standalone:2.1.0
# cwd=apps/server；脚本自带安全默认 env（回环、影子关、发送开、临时 DKIM 密钥）
pnpm exec tsx src/scripts/outreach-smtp-live-acceptance.ts
```

前置：dev 库已应用全部迁移（本次先补部署了 6 条已合入 main 但未应用的迁移）。容器用后 `docker rm -f`。

## 不能证明什么（限制）

- **STARTTLS(587) 升级路径未覆盖**：GreenMail standalone 不提供 SMTP STARTTLS 开关（实测 EHLO 只广告
  AUTH），本验收走 SMTPS 直连 TLS；真实 Gmail 587 的 STARTTLS 升级需在有真实凭据时复验。
- **AUTH 未实测**：GreenMail `auth.disabled`；生产密码认证分支由代码路径 + 单测覆盖。
- **DNC 用空桩**：DNC 走引擎 HTTP，本验收不启动引擎；DNC 语义由引擎侧与单测覆盖。
- **未经 job worker 队列**：脚本直接调用 `sendBatch`；worker/退避/advice lock 由 #130 单测覆盖。

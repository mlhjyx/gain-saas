# P4-13 真实 IMAP 验收（本地 GreenMail，零费用，2026-11-10）

用本机免费容器 **GreenMail v2.1.0**（IMAPS `127.0.0.1:3993`）对 IMAP 入站链路做真协议验收：
「取未读 → ingest（归因/幂等/停发联动）→ 标记已读」。全程不花钱、不发外网邮件、不碰生产信箱；
dev 数据库（`gain_saas@127.0.0.1:5433`）夹具在脚本结束时清理。

## 运行方式（可复现）

```bash
docker --context default run -d --name greenmail-imap-check \
  -p 127.0.0.1:3993:3993 -p 127.0.0.1:3025:3025 \
  -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.auth.disabled -Dgreenmail.hostname=0.0.0.0' \
  greenmail/standalone:2.1.0

cd apps/server
OUTREACH_IMAP_ENABLED=false OUTREACH_IMAP_HOST=127.0.0.1 OUTREACH_IMAP_PORT=3993 \
OUTREACH_IMAP_USER=outreach@example.test OUTREACH_IMAP_PASSWORD=pass \
OUTREACH_SMTP_TLS_REJECT_UNAUTHORIZED=false \
pnpm exec tsx src/scripts/outreach-imap-live-acceptance.ts
# 退出码 0 = 全过；对账 JSON 见 stdout（末段）
```

## 验收结果（2026-11-10，全部 PASS，exit 0）

| # | 检查 | 结果 |
| --- | --- | --- |
| 1 | fixture：INBOX 初始为空 | PASS（total=0） |
| 2 | run1 取未读→ingest：1 归因回复 + 1 DSN 硬退 + 1 未归因 | PASS（processed=2, unmatched=1, duplicates=0, errors=0） |
| 3 | ingest 归因：outreach_reply 关联 contactRef、kind=REPLY | PASS |
| 4 | 停发联动：回复写 email OPT_OUT（source=reply:reply） | PASS |
| 5 | DSN 硬退（5.1.1）：outreach_reply kind=BOUNCE | PASS |
| 6 | run2 幂等：已读后不重复处理 | PASS（processed=0, duplicates=0） |
| 7 | `\Seen` 标记：三封邮件全部已读 | PASS（total=3, unseen=0） |

## 验收发现并修复的真实缺陷

**轮询器把信箱地址当成了 IMAP 邮箱名**：`ImapFlowClient.fetchUnseen(mailbox.address)` 原先把
`outreach@example.test` 传给 `getMailboxLock()`，而真实收件箱名是 `INBOX`——在 GreenMail 上直接
`NO [NONEXISTENT]`；生产 Gmail 会同样失败（只是错误更晚出现）。已修复：新增
`OUTREACH_IMAP_MAILBOX`（默认 `INBOX`）作为真实收件箱名，地址仅作账号关联标签。

## 不能证明什么（生产验收仍待）

- GreenMail 是**本地协议级**验收：证明登录/取未读/标记已读/归因/停发联动整链在真实 IMAP 上成立；
  不证明 Gmail/M365 的 provider 行为（配额、标签、DSN 变形、ARF 兼容）。
- 生产信箱凭据（域名五件输入）到位后仍需按同一脚本对真实信箱跑一次（改 host/port/user/pass 即可），
  并把结果补进本目录。
- 多信箱并发轮询与 `secret_ref` 凭据管理仍属后续卡片。

# P4 第二波 B：回复/退信/投诉 ingest 与 warmup 周清单（2026-11-09）

分支：`claude/outreach-ingest`（stacked on `claude/outreach-gate` / PR #125）。承接 ch05 P4-06（回复 ingest 核心）
与 P4-12（warmup/seed 周清单后端）。发送总开关默认关、影子默认开；不发真实邮件、不部署。

## 交付清单

| 能力 | 实现 | 验证 |
| --- | --- | --- |
| 邮件解析核心 | `outreach-email-ingest.ts`：头解析（折行归一/References）、multipart 拆分、base64/quoted-printable 解码、DSN（`message/delivery-status`：Status/Action/Final-Recipient/诊断码/原邮件 id）、ARF（`message/feedback-report`：Feedback-Type/原收件人/原邮件 id） | `outreach-email-ingest.spec.ts` 9 例（含 5.x 硬退/4.x 软退/投诉/退订关键词） |
| 归因与 ingest | `outreach-ingest.service.ts`：In-Reply-To / References / DSN / ARF 的原始 Message-ID → `outreach_send.messageId` → draft.contactRef；幂等键=入站 Message-ID（缺失退化为原文 SHA-256）；未归因/重复分别返回 `UNMATCHED`/`DUPLICATE` 并留审计 | `outreach-ingest.service.spec.ts` 9 例（回复/硬退/软退/投诉/退订/重复/未归因/无 Message-ID） |
| 停发语义 | 复用 `OutreachReplyService`：REPLY/UNSUBSCRIBE/硬退/投诉写 OPT_OUT（跨批次停发）；**软退信（4.x.x）只计数不压制**（`suppress=false`，重试仍可送达） | 同上（软退无 OPT_OUT 行断言） |
| HTTP 入口 | `POST /api/outreach/replies/ingest {raw}`（TenantGuard+AdminGuard，≤256KB） | 服务层测试；控制器为薄封装 |
| 并发幂等 | 迁移 `20261109220000_outreach_reply_external_id_unique`：先清历史重复（按 workspace+external_id 保留最早一条），再建部分唯一索引（`WHERE external_id IS NOT NULL`）；ingest 捕获 P2002 → `DUPLICATE` | 迁移在一次性库上用「先造重复再应用」验证：保留最早一条、NULL 行不受影响、重复插入被索引拒绝；ingest 竞态用例（绕过查重后插入撞 P2002 → DUPLICATE） |
| IMAP 轮询 | `outreach-imap.poller.ts`：遍历 ACTIVE 信箱取未读 → ingest → 标记 \Seen；单信箱/单封失败互不阻塞；`OUTREACH_IMAP_ENABLED` 默认 false，`imapflow` 惰性动态加载（未安装时轮询器记错误、不影响其他功能） | `outreach-imap.poller.spec.ts` 3 例（fake client：计数/失败隔离/ingest 抛错不标记） |
| warmup/seed 周清单 | `GET /api/outreach/warmup/checklist`：按域输出最近 7 天种子是否新鲜、Inbox≥80/Spam≤10 判定、信箱全部 ACTIVE、各信箱今日/本周用量与余量 | `outreach-warmup.service.spec.ts` 2 例 |

## 本机验证

```
apps/server outreach+campaign：25 files / 234 tests 绿（vitest）
tsc -p tsconfig.json --noEmit 绿
packages/shared：5 files / 39 tests 绿
```

## 发车门槛（imapflow，强制）

**打开 `OUTREACH_IMAP_ENABLED=true` 之前必须完成以下三项，否则轮询不可用（配置默认 false，不会静默假装工作）：**

1. ~~安装依赖 `imapflow`~~ **已完成（2026-11-10）**：`imapflow@2.11.0` 已入 `apps/server/package.json` 与 pnpm-lock，
   适配器改为静态类型导入（P4-10 分支）；
2. 配置 `OUTREACH_IMAP_HOST/PORT/USER/PASSWORD` 并用真实信箱做一次「取未读 → ingest → 标记已读」验收，
   把验收用的 Message-ID 与 ingest 结果记录在本目录（**待真实信箱凭据**）；
3. 多信箱投产前把凭据从进程级 env 改为按 `outreach_mailbox.secret_ref` 引用。

## 不能证明什么

- **没有真实 IMAP 连接**：环境无法安装 `imapflow`（registry 经代理超时，本轮已如实降级为惰性适配器）。
  `ImapFlowClient` 的选择器/标志位语义只经过类型与单元桩验证；拿到真实信箱凭据后需按
  `OUTREACH_IMAP_*` 配置做一次真实轮询验收，并把多信箱 `secret_ref` 化。
- 解析器覆盖的是产品会遇到的常见形态（纯文本/multipart/DSN/ARF/base64/QP）；非 UTF-8 charset、
  嵌套 multipart、TNEF 等未覆盖——遇到时按 `UNMATCHED`/原文片段落库，不会误判为投诉/退订。
- 退订识别是保守关键词（unsubscribe/abmelden/désinscrire），不做情绪/意图分类；分类仍由步 13 技能负责。
- warmup 清单输出的是「本周快照」；「连续两周不达标暂停该域」的跨周判定由运营台消费多周快照完成。

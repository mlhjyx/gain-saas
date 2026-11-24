# 2026-11-25 — Batch 1.3 外联 8 连环 Bug 修复与 Ring-1 P0 安全/配额/事件封堵

- **外联 8 连环 Bug 根治**：
  - `outreach-email-ingest.ts` / `outreach-ingest.service.ts`：先剥离引用回复块（`>` / `On ... wrote:` / `Am ... schrieb:` 等）再执行 `looksLikeUnsubscribe()`，终结正常买家回复被我方页脚误杀退订拉黑；补递归多层 MIME 解析、RFC 2047 头解码、OOO 自动回复识别（不误写 `OPT_OUT`）与 256KB 防毒丸截断；
  - `outreach-imap.poller.ts`：多租户并存轮询时对 `UNMATCHED` 邮件禁止抢先标 `\Seen`，杜绝跨租户吞信；
  - `outreach-batch-lock.ts`：在 `$transaction` 内走事务级 `pg_try_advisory_xact_lock` 绑定单一连接，杜绝连接池跨连接解锁泄漏；
  - `outreach-dnc.checker.ts`：超过 50 条邮箱自动按 50 分块请求引擎 `/outreach/dnc/check`；
  - `outreach-smtp.transport.ts`：补齐 `connect`/`upgrade` 建连与 TLS 握手 `socket.setTimeout`、禁 `<>` 注入、合法 FQDN `EHLO` 与发完优雅 `QUIT`；
  - `outreach-jurisdiction.ts`：补齐 D3 `CA/AE/SA` `CONSENT_REQUIRED` 与 `GB/UK` PECR 企业法人判定；
  - `outreach-unsubscribe.service.ts` / `outreach-public.controller.ts` / `outreach-bounce-writeback.service.ts`：退订 token TTL 升至 90 天；公共退订页补 `Cache-Control: no-store` / `X-Frame-Options` / 限流 / 平台抑制重试；退信回写补 `FOR UPDATE SKIP LOCKED`。
- **Ring-1 P0 安全、配额与事件封堵**：
  - `settlement-readback-proxy.ts`：严格校验转发路径并拦截 `..` / `%2e` / `\\` 路径穿越 SSRF；
  - `machine-token.controller.ts`：生产/mTLS 模式强制校验证书 CN（`MACHINE_TOKEN_MTLS_REQUIRED`），禁止回退默认主体铸币；
  - `tenant.guard.ts`：先验成员资格与工作空间 `ACTIVE` 再滑动续期，先签新会话再吊销旧 jti 防并发自踢；
  - `acquisition-tasks.controller.ts`：保留 `WorkspaceBudgetQuotaExceededError` HTTP `402`（不再吞成 `502`）；`task.icpId=null` 同样强制落账 `discovery_run_link` 封堵配额绕过；
  - `event-consumer.service.ts`：支持标准 UUIDv1–v8、对收件箱已隔离事件记录审计警告、修复 `SanctionsListStale` `yellow→red` 限频吞警、补齐 `DeletionCompleted` / `ClaimRevoked` / `SiteBuildCostSummaryUpdated` 分支；
  - `main.ts`：补全安全响应头、`app.enableShutdownHooks()` 与 51MB 上传前登录态校验。

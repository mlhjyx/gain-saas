# P4 第三波：发送 job 队列与熔断器持久化（P4-04 剩余 + P4-08，2026-11-10）

分支：`claude/outreach-jobs-health`。发送总开关默认关、影子默认开、job worker 与健康评估默认关；
不发真实邮件、不部署。

## 交付清单

| 能力 | 实现 | 验证 |
| --- | --- | --- |
| 发送 job 队列（P4-04） | `outreach_send_job` 表（幂等键 `sha256(batchId\|draftId\|1)` 唯一、claim_token 原子认领、attempts/nextAttemptAt）；批次审批通过时逐草稿入队（`createMany skipDuplicates`） | `outreach-send-jobs.service.spec.ts` 3 例（认领/重排/终态守卫）；`outreach-batch.service.spec.ts` 批准即入队断言 |
| 批次互斥 | `PostgresAdvisoryBatchLock`（`pg_try_advisory_lock(hashtextextended(batchId,0))`，finally 释放） | `outreach-batch-lock.spec.ts` 3 例（获取/占用/异常仍释放） |
| 发送 worker | `OutreachSenderWorker`：claim → 按批次 advisory lock → 复用完整门序发送 → 按台账结果推进 job（SENT/SKIPPED=DONE；FAILED 退避重试 ≤3 次；顺延草稿按窗口重排；批次不存在=CANCELLED；锁占用整组推迟 60s）。双开关守卫：`OUTREACH_SENDER_ENABLED` 且 `OUTREACH_SEND_ENABLED` 且影子关闭才启动 | `outreach-sender.worker.spec.ts` 6 例 |
| 熔断器持久态（P4-08） | `outreach_breaker`（CLOSED→OPEN→HALF_OPEN→CLOSED 状态机）+ `outreach_health_event`；评估口径：mailbox 硬拒率 ≥5%（样本 ≥20）、domain 退信率（DSN+硬拒）≥10% 或投诉率 ≥0.3%（样本 ≥100） | `outreach-health.service.spec.ts` 5 例（开闸/不重复开闸/scope 拒绝/两步恢复/面板） |
| 发送路径接熔断态 | OPEN → 整批 `OUTREACH_MAILBOX_PAUSED`/`OUTREACH_DOMAIN_PAUSED`；HALF_OPEN → 只发 ≤`OUTREACH_HALF_OPEN_BATCH_LIMIT`(10) 小批，其余顺延 `OUTREACH_HALF_OPEN_CAP` | `outreach-send.service.spec.ts` +2 例 |
| 评估与恢复 API | `GET /api/outreach/health`（面板）、`POST /api/outreach/health/evaluate`（管理员）、`POST /api/outreach/health/:scope/:ref/recover`（OPEN→HALF_OPEN，必须根因）、`.../close`（HALF_OPEN→CLOSED，必须复核说明）；评估 worker `OUTREACH_HEALTH_EVAL_ENABLED` 默认 false | 服务层 5 例；控制器为薄封装 |
| 错误文案 | `OUTREACH_HALF_OPEN_CAP` / `OUTREACH_BREAKER_NOT_FOUND` / `_NOT_OPEN` / `_NOT_HALF_OPEN` 登记中英三层 | `errors.test.ts` |

## 本机验证

```
apps/server outreach：20 files / 181 tests 绿；tsc --noEmit 绿
迁移：一次性库 prisma migrate deploy 全链通过（20261110090000_outreach_send_job /
      20261110091000_outreach_health_breaker，均 additive）
```

## 语义与边界

- **job worker 与手动发送端点并存**：worker 只在真实发送模式（开关开 + 影子关）启动并持批次 advisory lock；
  手动 `POST /send` 用于影子/关闭状态演练，不取 advisory lock——两者同时开闸属误用，运营纪律见 RUNBOOK（未变）。
- **顺延语义**：窗口/限速/额度/半开小批命中时草稿保持 APPROVED，job 按 `OUTREACH_SEND_JOB_DEFER_SECONDS`
  重排；发送失败按 `30/120/600s` 退避，≤3 次后 job FAILED（草稿已在台账记 FAILED，可人工重开）。
- **升级兼容**：本迁移前已批准在队的批次没有 job 行——worker 不会自动发送它们，需重新审批或手工触发一次
  （开发库无生产批次；发车前运营需核对 `outreach_batch QUEUED` 与 job 数一致）。
- **未覆盖**：负面回复率（缺模板归因）、成本每会议（属 P4-09）、合规违规自动信号（无信号源）本期不自动开闸；
  SENDING/HALTED/PAUSED 批次状态与人工急停端点仍未加（急停用 breaker OPEN + 授权撤销组合）。

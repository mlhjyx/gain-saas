---
date: 2026-11-09
title: P5b-05 — 幂等键：SaaS 去重重放 + 前端 usePendingAction
---

- 起因：ch07 §7.5 P5b-05（QW7 先行）——「点一次、发两次」在网络抖动/双击下会重复执行接受、触达、预算扣减等副作用；前端防抖只能挡住同页双击，挡不住「请求已到、响应丢失、用户重试」。
- 改动：
  - **SaaS 侧**：新增 `idempotency_record` 表（迁移 `20261109230000_idempotency_keys`）；`IdempotencyService` + `IdempotencyInterceptor`（全局 APP_INTERCEPTOR）——租户域变更请求带 `Idempotency-Key` 时，同一 (租户, 路由模板, 键) 只执行一次并存储首次 (status, body)；重放直接返回首次响应；同键不同请求体返回 409 `IDEMPOTENCY_KEY_REUSED`；TTL 24h。未带键的请求完全不受影响。
  - **前端**：`usePendingAction`（双击/并发复用同一在飞 Promise；失败后键保留供重试复用，成功后换新键）；线索接受/拒绝 API 透传 `Idempotency-Key` 头；线索详情页接线。
  - **E2E**：mock-backend 记录请求头；新增「失败重试沿用同一键」「成功后再发起新动作换新键」两例（真实双击防抖沿用原韧性用例）。
- 测试：server 单测（键格式/放行/首次与重放/409/竞态/摘要确定性）；e2e 两例；tsc/vitest 全绿。
- 未做：其它写操作（触达发送、任务重试）的键接线（同一拦截器已生效，只需前端逐处透传，后续卡批量接）；过期行清理任务（惰性，量级低）。

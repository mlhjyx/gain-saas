---
date: 2026-11-21
title: Consume the two missing engine events + sanctions-stale error copy
---

- 缺口 1（文案）：`SANCTIONS_LIST_STALE` 进三层文案词表——引擎在制裁名单超过更新时限/名单源异常时以 409 拒绝接受线索，此前用户看到「未登记错误」兜底且重试无效；现在明确「合规保护、非操作错误、名单刷新后自动恢复」。
- 缺口 1（消费）：事件消费器新增 `SanctionsListStale` 分支 → 站内通知（freshness yellow/red 区分文案；refId=icpId）。引擎已按 (workspace, freshness, 名单源) 6h 去重，SaaS 再按 workspace 24h 限频防铃铛轰炸。
- 缺口 2：事件消费器新增 `CampaignPlanJobFailed` 分支——控制面 PATCH 重试耗尽后的双通道兜底（ch08 §3.1.4）：把仍处 PENDING/RUNNING 的方案 job 置 FAILED（payload.jobId 即 SaaS campaign_plan_job.id）+ issues 透传存证 + 站内通知；已被主通道终结的幂等跳过。
- 通知回退键：notifications.sanctionsStale/planJobFailed（zh/en，与现有 camelCase 回退表同约定；当前 notify 恒带 title/titleEn，回退键为兜底保险而非主路径）。已知取舍：引擎 qualify 路径的 SanctionsListStale 载荷无 freshness 字段，SaaS 按红档文案展示（该路径仅在名单过限或源故障时发出，fail-closed 语义正确）；workspace 级 24h 限频在多实例并发下非严格（当前单 worker 实例 + tick 防重入，实际无并发）。

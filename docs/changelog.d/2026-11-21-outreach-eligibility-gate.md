---
date: 2026-11-21
title: Outreach send gate wired to the engine eligibility source (adapter gap 3)
---

- 发送前预检（P1-16 接线）：新开关 `OUTREACH_ENGINE_ELIGIBILITY_ENABLED`（默认关闭）。开启后批次发送在 DNC 合规门之后追加引擎 `POST /outreach/contact-eligibility` 质量门——只有引擎四态为 VALID（allowedActions 含 outreach）的邮箱放行，INVALID/CATCH_ALL_RISKY/UNKNOWN 逐封 SKIPPED（`OUTREACH_ELIGIBILITY_BLOCKED:<state>`）；引擎不可达整批 fail-closed（`OUTREACH_ELIGIBILITY_UNAVAILABLE`），与 DNC 合规门同语义。
- 退信回写：SMTP 5xx 硬拒与 DSN 退信（硬/软）先落本队列表 `outreach_bounce_writeback`（(contact_point_id, message_id) 唯一吸收重复），60s worker 批量调引擎 bounce-events（messageId 幂等键；404 视为永久失败；尝试上限 5；未配置服务令牌时 drain 跳过不烧次数）。硬退使引擎侧联系点置 INVALID（粘滞），软退 ×3 触发 24h 重验。
- 草稿寻址：`outreach_draft.contact_point_id` 新列（legacy NULL，回写跳过并计数不阻塞）；web 选人时随 email 通讯点带入。引擎 eligibility 响应若后续补 contactPointId（需求已发引擎负责人）即可全覆盖。
- 平台级抑制上报（dnc/suppress）此前已接线，本次未动。
- 测试：checker 4 例（哈希还原/未命中兜底/分块/fail-closed）、发送门 8 例（flag 关/VALID 放行/逐封跳/整批拒/硬拒入队/软拒不入队/legacy 兼容）、回写服务 4 例（幂等入队/成功/404 终结/无令牌跳过）；server 单测全绿。
- 评审修复（独立 agent FAIL→复验）：checker 请求补必填 workspaceId（缺失即引擎 400，flag-on 全批拒绝）；开关改用文件既有严格布尔约定（coerce.boolean 会把 "false" 字符串变 true）；门序钉死 DNC→eligibility（合规优先 + 被拦草稿不消耗引擎调用，测试钉住）；编辑草稿换邮箱未带新通讯点 → 清空旧 pointId（防退信回写错位到他人联系点，引擎 INVALID 为粘滞）；迁移索引名对齐 Prisma 约定。

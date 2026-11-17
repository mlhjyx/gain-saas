---
date: 2026-11-17
title: 官网合作意向公开 API 与运营台合作意向页
---

- 起因：官网需要一个提交合作意向的入口，线索要能被运营看到；公开端点必须能抵御恶意提交与 XSS。
- 改动：新增 `POST /api/public/cooperation-intents`（无登录态，CORS 可配、16KB 体积上限、IP/邮箱双维度持久化限流、字段级 XSS 清洗），线索落 `cooperation_intent`（Prisma 迁移 `20261117120000_cooperation_intent`）；运营台新增「合作意向」页与 `GET/PATCH /api/ops/cooperation-intents`（状态与备注，写操作进审计）；官网对接文档见 `docs/api/cooperation-intents.md`。
- 测试：sanitizer 单测（标签/协议/实体编码/零宽/码点长度/多行）、service 单测（清洗后落库、IP 只存 HMAC、XSS 拒绝不落库、限流 429、状态更新与审计）；`pnpm --filter @gain-saas/server test` 全绿。
- 未做：不创建引擎 Company/Lead 主状态；不发通知邮件；不做验证码（限流 + 清洗已覆盖当前风险，后续可按提交量加 Turnstile）。

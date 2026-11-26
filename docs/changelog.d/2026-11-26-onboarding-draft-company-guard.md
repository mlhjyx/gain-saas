---
date: 2026-11-26
title: 修复引导建档阶段 TenantGuard 误拦草稿公司 PDF 画册上传与选国推荐的问题
---

- 起因：PR #212 在 `TenantGuard` 新增未完成引导路径前置拦截时，仅放行 7 个固定前缀，未纳入 PR #210 在 `BffGuard` 中为草稿公司（`onboardingCompanyId`）放行的 7 条画册上传与 UN Comtrade 选国推荐路由，导致新用户在建档第 1 步上传 PDF 画册时触发 `409 ONBOARDING_INCOMPLETE`。
- 改动：在 `apps/server/src/tenant/tenant.guard.ts` 导出并复用同一份草稿公司读写路由白名单（严格校验 HTTP 方法、路由段结构、路径参数合法性与 `:companyId === onboardingCompanyId`），`BffGuard` 直接引用同一集合并保留写路由的 `AdminGuard` 校验；在 `tenant.guard.status.test.ts` 与 `onboarding.controller.test.ts` 补齐正反例与真实 `TenantGuard + BffGuard + AdminGuard` 串联单测。
- 验证：`@gain-saas/shared` / `@gain-saas/ops-pg` / `@gain-saas/server` 编译通过，`tenant.guard.status.test.ts`、`onboarding.controller.test.ts`、`bff.test.ts` 全部通过，`pnpm lint:terms`、`pnpm lint:date`、`gitleaks` 均绿。
- 未做：未改前端建档页交互（四选一/多材料组合与 PDF 解析展示待产品确认后单开 PR 处理），未改数据库迁移与引擎接口。

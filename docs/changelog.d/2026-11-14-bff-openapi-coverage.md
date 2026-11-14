---
date: 2026-11-14
title: Machine-checked BFF route coverage against the pinned engine contract
---

- 起因：BFF 路由表与 packages/engine-client 的固定合同没有机器对照，新增引擎端点可以悄悄透传而合同未收录；升级合同时也没有提示要复核 BFF 覆盖面（PR-12）。
- 改动：新增 `apps/server/src/bff/openapi-coverage.ts` 与 `openapi-coverage.spec.ts`——把 84 条 BFF 路由逐条对照固定合同（`/api/v1` 前缀与 `{param}` 模板归一），已覆盖 50 条；未覆盖的 34 条登记在 `openapi-coverage.baseline.json` 并写明原因。基线绑定 `engine-contract.lock.json` 的 `pinnedAt`：合同升级后测试会红，强制重新生成清单；新增 BFF 路由若不在合同且未登记同样会红。
- 测试：`pnpm --filter @gain-saas/server test` 全覆盖；清单数量（84/50/34）也被快照锁定。
- 未做：不升级引擎合同（独立高风险 PR），不改任何 BFF 运行时行为；引擎侧未被 BFF 暴露的操作不在本清单内。

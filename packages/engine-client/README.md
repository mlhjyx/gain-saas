# @gain-saas/engine-client

引擎（global/backend）OpenAPI 合同的固定版本与生成类型。

- 引擎 API 基路径：**`{ENGINE_ORIGIN}/api/v1`**（全局前缀 `/api` + URI 版本化，默认 v1）；文档/合同端点（`/api/docs-json`）不在版本化前缀下。
- `pnpm gen`（或根目录 `pnpm gen:engine`）：从运行中的引擎 `GET /api/docs-json` 拉取合同 → `src/openapi.json` → `openapi-typescript` 生成 `src/schema.d.ts`。只在**升级引擎合同**时运行。
- `pnpm -F @gain-saas/engine-client gen:types`：只从仓库内的固定合同重新生成 `src/schema.d.ts`（离线）。
- BFF 禁止手写与引擎平行的字段定义（技术方案 §6）；生成物不得手工编辑。

## 合同固定（pin）与 CI

`src/openapi.json` 是**显式固定**的合同副本，可以落后于引擎 head：

- `engine-contract.lock.json` 记录合同文件的 `specDigest`（SHA-256，分段存储）。CI 运行 `scripts/verify-pin.mjs`，合同字节与锁文件不一致即失败。
- CI 另跑 `gen:types` 并用 `git diff --exit-code -- src/schema.d.ts` 证明生成类型与固定合同一致。
- 运行中的引擎实例只在本机/部署机用 `pnpm gen:engine` 对账，CI 不依赖引擎实例（2026-11-11 前该检查因依赖实例而 `continue-on-error` 长期失效）。

## 升级引擎合同（独立 PR，按高风险变更处理）

1. 确认目标引擎版本（记录镜像 digest 或源码 commit；例如 `local-config/global/runtime.compose.env` 的镜像 digest 与其 `org.opencontainers.image.revision`）。
2. 在部署机对目标引擎运行 `pnpm gen:engine`，得到新的 `src/openapi.json` 与 `schema.d.ts`。
3. 审查 OpenAPI diff 与类型 diff；更新 `engine-contract.lock.json`（`specDigest` 取自新合同，`pinnedFrom` 记录引擎版本与取得日期）。
4. 补/改消费方代码与测试；PR 正文写明引擎版本、兼容结论与回退方式。
5. CI 在合同文件变化的 PR 上运行 `oasdiff` breaking 检查；确需破坏性变更时由产品负责人批准后在 PR 打 `engine-contract-breaking-approved` label，并在 PR 中说明迁移方案。

## 事件合同（已知缺口）

引擎 outbox 事件的 payload 兼容性目前没有机器校验（事件信封有 `schemaVersion`，但 SaaS 消费端只按类型分支）。升级引擎合同时必须人工核对消费端字段，并在 evidence 中记录；把事件 schema 纳入固定合同是后续工作（见 `docs/status/current.md`）。

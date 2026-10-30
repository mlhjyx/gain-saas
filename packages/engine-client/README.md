# @gain-saas/engine-client

引擎(global/backend)OpenAPI 合同的生成物包。

- 引擎 API 基路径:**`{ENGINE_ORIGIN}/api/v1`**(全局前缀 `/api` + URI 版本化,默认 v1);文档/合同端点(`/api/docs-json`)不在版本化前缀下。
- `pnpm gen`(或根目录 `pnpm gen:engine`):从运行中的引擎 `GET /api/docs-json` 拉取合同 → `src/openapi.json` → `openapi-typescript` 生成 `src/schema.d.ts`。
- 合同变更后必须重新生成;CI 校验生成物无漂移。BFF 禁止手写与引擎平行的字段定义(技术方案 §6)。
- M1 起在此增加类型化 fetch 封装(基于 schema 的 paths 类型)。

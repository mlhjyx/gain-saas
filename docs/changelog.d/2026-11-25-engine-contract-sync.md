# 2026-11-25 — 升级引擎固定 OpenAPI 合同至 `global-backend@05ada06a`（Batch 1.3 独立合同 PR）

- **来源**：`global-backend` `main@05ada06aeb8aa8a1c35e0c5af0ce90955f7351eb`（Batch 1.1 + Batch 1.2 全量合入后，`158 → 166` 条路径）。
- **变化摘要**：
  - 新增 5 条 `canonical-companies/:id/contact-enrichment-{results,quality-facts}` 安全只读/恢复路径；
  - 新增 3 条 `companies/:companyId/seller-documents/:documentId/{chunks/:seq,claim-previews,claim-drafts}` S1a 文档原句引用路径；
  - `ClaimDto.statement` 由 `string` 扩展为 `string | null`（源文档失效或删除时服务端脱敏为 `null`）并新增 `documentSource` 字段。
- **验证**：`verify-pin.mjs`、`gen:types` 零 diff、`pnpm lint:terms`、`pnpm lint:date`、`pnpm build`、`pnpm test`（含 93/93 BFF OpenAPI 覆盖率）全部通过。

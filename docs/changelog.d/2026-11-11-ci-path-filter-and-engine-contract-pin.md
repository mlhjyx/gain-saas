---
date: 2026-11-11
title: Path-filtered CI, secret scanning and an offline engine-contract pin
---

- 起因：SaaS CI 对纯文档 PR 也跑完整 build + Playwright E2E；引擎合同漂移检查依赖运行中的引擎实例，长期 `continue-on-error` 形同虚设；仓库没有任何密钥扫描。
- 改动：
  - 新增 `classify` job：仅当全部改动落在 `docs/**`、根 `README.md`/`AGENTS.md` 时判为 docs-only（非 PR、diff 缺失或失败一律全量，fail-safe）。
  - `build-test` 的代码步骤与 `e2e` job 在 docs-only 时跳过并显式记录 fast-path 步；`classify` 失败时 build-test 以 `!cancelled()` 启动并在第一步显式失败。
  - 新增 `secret-scan` job（gitleaks-action，pin SHA `e0c47f4f…`），文档 PR 同样扫描。
  - 引擎合同改为离线确定性检查：新增 `packages/engine-client/engine-contract.lock.json` 与 `scripts/verify-pin.mjs`（sha256 校验）；CI 跑 `gen:types` + `git diff` 证明 `schema.d.ts` 与固定合同一致；删除了依赖运行中引擎的 `pnpm gen:engine` + `continue-on-error` 漂移检查；合同文件变化的 PR 用 oasdiff 对 base 合同做 breaking 检查（`engine-contract-breaking-approved` label 放行）。
  - `packages/engine-client/README.md` 写明 pin/升级/破坏性变更流程与事件合同缺口。
- 测试：本地 `node packages/engine-client/scripts/verify-pin.mjs` 通过（sha256 `18e77c63…`）；YAML 解析通过；顺带修复 `outreach-experiments.service.spec.ts` 的随机盐假红（硬编码 REF_B 改为本次分配使用的 otherRef，约 1.2% 盐会触发）；真实效果以本 PR 的 CI（全量路径）与后续 docs PR（快通道）对比观察。
- 未做：事件 payload 兼容性的机器校验（缺口已写入 README 与状态页）；不引入 merge queue 或远程缓存。

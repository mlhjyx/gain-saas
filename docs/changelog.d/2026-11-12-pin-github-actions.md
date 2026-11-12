---
date: 2026-11-12
title: 将 GitHub Actions 钉到 40 位 commit SHA
---

- 起因：2026-11-12 审计 L-8：SaaS `ci.yml` 仍有 `actions/checkout@v4`、`actions/setup-node@v4`、`actions/upload-artifact@v4` 等 moving tag；backend 已全部按 SHA 钉住。
- 改动：`ci.yml` 的 8 处 action 引用全部改为 40 位 commit SHA（保留 `# v4` 注释）；新增 `scripts/check-action-pins.mjs` 并在 build-test 中执行，新增 moving tag 会让 CI 红。
- 测试：`node scripts/check-action-pins.mjs`；CI 全量 build/test/contract 与 e2e。
- 未做：不升级 action 大版本（只钉住当前 v4）。

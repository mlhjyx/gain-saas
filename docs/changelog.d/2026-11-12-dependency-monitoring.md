---
date: 2026-11-12
title: 依赖监控：Dependabot 安全更新 + 每周生产依赖审计
---

- 起因：2026-11-12 工程审计（L-2）发现本仓 Dependabot alerts 被禁用、没有 `.github/dependabot.yml`、CI 也没有依赖审计，SaaS 依赖漏洞处于零监控状态。本地对官方 registry 实测生产依赖为 2 critical / 4 high / 6 moderate / 2 low。
- 改动：
  - 新增 `.github/dependabot.yml`：只保留安全更新（production/development 两个分组），版本更新关闭（`open-pull-requests-limit: 0`）；github-actions 同样只做安全更新。
  - 新增 `.github/workflows/dependency-audit.yml`：每周一 04:23 UTC + 手动触发，对生产依赖跑 `pnpm audit --prod --audit-level=high`。仓库 `.npmrc` 指向 npmmirror，故显式使用官方 registry；不使用 `--ignore-registry-errors`，registry 故障按失败处理而不是静默通过。
- 测试：本地以 `--registry=https://registry.npmjs.org/` 跑同一命令，确认能真实返回 advisories（当前为红，等待依赖修复）；workflow 语法与 action pin 按 backend 已审计的 SHA。
- 未做：本次只落地监控，不修复依赖漏洞。multer / @vue/server-renderer / glob / deepmerge-ts / tinypool 等 14 个生产漏洞的升级与回归另立任务。

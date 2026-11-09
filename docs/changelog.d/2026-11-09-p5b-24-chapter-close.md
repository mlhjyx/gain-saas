---
date: 2026-11-09
title: P5b-24 — 深链 redirect 核对器、前端回退演练手册与运营台衔接说明
---

- 起因：ch07 P5b-24 —— 前端没有页面级回退演练与深链核对，路由重构后历史书签可能 404；运营台与租户界面的边界也需要一处写清楚的说明。
- 改动：
  - `scripts/check-legacy-redirects.mjs` + test：静态核对 `legacy.ts` 的每条 redirect 目标是否仍命中已定义路由（含 `/settings` 父子路由组合）；缺失目标/重复 source 直接红，已接入根 `test` 链。
  - `docs/engineering/frontend-release-rollback.md`：发布形态、页面级回退步骤（revert PR → CI → 重建 + systemd 重启，<10 分钟）与验证清单、深链 ≥2 版本策略、运营台 scope/通知衔接、本章关闭口径（P5b-18/21/23 与 09 尾巴未完成前不关闭）。
- 测试：核对器 3 例（解析含子路由组合、目标命中、缺失/重复检出）；实跑输出「5 条 redirect，目标均在 22 个已定义路径中」。
- 未做：首次真实回退演练（待下一班前端发版后按手册空跑并记录耗时）；P5b-18/21/23 维持未完成。

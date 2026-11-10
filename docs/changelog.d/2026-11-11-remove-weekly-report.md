---
date: 2026-11-11
title: Remove the weekly-report feature from the SaaS
---

- 起因:产品决定取消周报功能(交付节奏改由线索交付与商机转化承接);引擎侧 report 模块自包含、无其它模块依赖,SaaS 移除不会孤儿化引擎代码,引擎本轮不动。
- 改动:删除 `/reports` 路由与 `views/reports/index.vue`、BFF 的 `reports/weekly` 与 `reports/weekly/feedback` 透传路由及 raw/csv 分支、`main.ts` 的 CSV raw-body 解析;工作台主链路六步改五步(周报跟进步骤与 /reports 入口卡移除);i18n 删除 `reports` 节与 `menu.reports`/`workspace.stepReport`/`nextReport*` 等键,`privacy.rightAccess` 改写;e2e(nav-shell/zero-jargon/responsive)同步;PRD §1.2/§2.1/§2.3/§7.2/§7.3/§7.5/§8/§9/§12 SD8/§14 全部标注取消,技术文档与状态文档同步。
- 测试:web typecheck + production build 通过;server typecheck + 全量单测通过;本地 CI=1 全量 e2e 全绿。
- 未做:引擎侧 report 模块与 `/reports/*` 端点保留(SaaS 不再调用);`lead_outcome` 表与 `POST /leads/:id/outcomes` 保留(线索详情仍可登记去向);`feedback_submission` 表保留作历史数据;预算功能本轮不处理。

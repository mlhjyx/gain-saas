---
date: 2026-11-10
title: 注册即建档——onboarding 反转为「先官网 → 理解预览 → 勾选确认」
---

- 起因：产品负责人 2026-11-10 批准客户旅程重构第 1 步。原 onboarding 让客户手填六项事实，理解要等建档后才开始；行业是自由文本，无法受控。
- 改动：
  - **向导反转**：`views/onboarding/index.vue` 改为两步——先填官网（名称/邮箱同屏，邮箱做域名一致性提示，不阻断），点「开始理解」后进入进度态（轮询已分析页数），理解就绪后展示可勾选的行业/产品/市场候选，确认即完成建档。没有官网走手动填写（同一份草稿档案补齐事实）；理解失败给「重试 / 手动填写」两个出口。
  - **BFF**：新增 `POST /api/onboarding/preview`（建/复用草稿档案并触发或重试理解，quote→Grant，草稿 id 记入 `onboardingCompanyId`，不改 completedAt）与 `GET /api/onboarding/preview`（恢复进行中的预览）；`POST /api/onboarding/company` 在有草稿档案时改为调用引擎 `onboarding-facts` 把勾选事实写回同一档案，无草稿时保留旧的一次性建档路径。完成时审计记录「建议 vs 选择」的计数（行业/产品/市场接受项、已分析页数、理解状态），供离线指标计算。
  - **行业受控**：向导行业改为受控词表下拉（词表随预览响应下发），提交 `industryCode`；词表不可用时回退自由文本。
  - **失败文案与重试**：理解失败按阶段映射为人话；重试被接受后前端进入等待态继续轮询（引擎同时清空失败标记），连点不会重复消费预算。
  - **状态守卫与幂等**：理解排队中（ENRICHING 或 DRAFT + 官网 + 无失败标记）完成建档返回 409，避免 extract_profile 稍后覆盖客户选择；预览建档带确定性 idempotency-key，并发/超时重试复用同一份草稿；排队中改官网返回可执行 409。
  - **候选质量**：市场国家只认词边界（Romania 不再命中 Oman/Niger/Mali），产品/市场/页数只收与当前官网同站的溯源；行业/市场标签按界面语言显示与提交。
  - **错误映射**：引擎网络失败统一折算 502 三层文案；旧一次性建档路径显式拒绝 `industryCode`（引擎 quote 作用域不含它）。
  - 新增错误码文案 `ONBOARDING_UNDERSTANDING_IN_PROGRESS`、`ONBOARDING_FACTS_NOT_ALLOWED`、`UNKNOWN_INDUSTRY_CODE`。
  - e2e mock 与主链路用例改为「官网 → 预览 → 勾选完成」，断言提交含 `industryCode`。
- 引擎依赖：`GET /companies/:id/understanding-preview` 与 `POST /companies/:id/onboarding-facts`（backend 仓同主题 PR）。发布顺序必须引擎先升级、SaaS 后上线。
- 测试：BFF onboarding 控制器 17 例（预览启动/重试/未开始/同档案完成/排队态与 ENRICHING 409/幂等键/旧路径 industryCode 拒绝），server 全量 633 例通过；web `vite build` 通过；Playwright main-chain 9/9 通过（含改造后的「官网 → 预览 → 勾选完成」用例）。`pnpm typecheck` 在未改动的 outreach/runs/tasks/workspace/metrics/reviews 视图与 vben 插件上仍有既有报错，本次未触碰这些文件。
- 未做：无官网的注册库建档与逐页进度（第 2 步）；公司档案 v2 的证据徽章与批量审批（第 3 步）；ICP 关键词建议（第 4 步）。设计见 `docs/superpowers/plans/2026-11-10-onboarding-understanding-preview.md`。

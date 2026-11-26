---
date: 2026-11-26
title: 建档画册升级为非阻塞双轨上传、实时进度条与解析要点展示，并放宽大文件上传超时
---

- 起因：用户一次上传 3 份 40MB 级印刷画册（共 121MB）时，旧实现在第 1 步顺序等待全部上传完成才跳转且使用无进度的 `fetch`，页面长时间形同卡死；同时慢网上传大文件容易触及 Node 默认 5 分钟 `requestTimeout`，卡片撑高时顶部 Logo 被裁切，第 2 步也无法看到画册解析进度与提取出的要点。
- 改动：
  1. 服务端（`apps/server/src/main.ts`、`apps/server/src/bff/routes.ts`）：将 HTTP `requestTimeout` 放宽至 15 分钟、资料二进制中转路由 `timeoutMs` 放宽至 10 分钟。
  2. 前端建档页（`apps/web/src/views/onboarding/index.vue`）：改用 `XMLHttpRequest` 实现逐文件实时进度条、已传体积、实时速率、单文件取消与失败重试；点击提交后立即进入等待/第 2 步确认视图，官网理解与画册上传双轨并行不阻塞；新增「产品画册上传与解析进度」面板并按 5 秒轮询同步解析段数与后端 `documents.extractedClaims` 要点展示；总选体积超 30MB 给出友好提示；修正 `.onboarding` 弹性居中导致高卡片顶部 Logo 被裁切的样式问题。
  3. 同步更新中英文 `"onboarding"` 文案与 `acq-p2-fast-onboarding-and-streaming.spec.ts` E2E 用例。
- 验证：`@gain-saas/server`、`@vben/web-antd` 构建与类型检查、`pnpm lint:terms`、`pnpm lint:date`、`gitleaks` 及建档 E2E 用例全绿。
- 未做：中转层暂维持内存缓冲未改流式直传；AI 文本/视觉二次抽取待单独评估立项。

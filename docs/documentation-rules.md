# 文档目录与维护规则（gain-saas）

> 文档 ID：`DOC-DOCUMENTATION-RULES-GAIN-SAAS-001`
> 生命周期：`GUIDE`
> 制定日期：2026-10-25（2026-11-04 改为单一源引用，原副本与 backend 仅一行差异且含悬空链接）
> 最后核验：2026-11-28（以 `gain-saas@ff45fa4` 核对目录、CI 范围与历史标注口径）
> 适用范围：gain-saas 仓的文档放置与维护。

本仓不再维护独立的文档目录规则副本。规则的唯一正文以 backend 仓 `docs/documentation-rules.md` 为准（含第 8 节「文档角色表」）；两仓规则若出现差异，以 backend 版本为准并回写本仓差异清单。

## 1. 本仓差异

- 文档根为 `docs/`，人类入口为 [docs/README.md](README.md)，当前状态页为 [docs/status/current.md](status/current.md)。当前 `docs/` 下目录为 `api/`、`prd/`、`status/`、`technical/`（含 `technical/adr/`）、`engineering/`、`evidence/`、`changelog.d/`、`superpowers/plans/`；随代码原位维护的文档包括 `apps/web/PRODUCT.md`、`deploy/*.md` 与 `packages/*/README.md`。文档导航列出现役入口，各目录仍保留自己的专题和历史记录。本仓没有 `modules/`、`shared/`、`archive/`。
- 发布顺序与阶段目标不在本仓维护；产品发布顺序的唯一来源是 backend 的 [docs/status/release-plan.md](https://github.com/mlhjyx/global-backend/blob/main/docs/status/release-plan.md)，本仓不建 `roadmap/`。
- 历史文档（含一期 `DRAFT` PRD/技术方案、旧交付读数与历史证据）保留原文与原日期，只标注时效与 successor 指针，不在多处复制实时状态或运行开关值。
- 本仓暂无 `docs-verification` 机器政策；新增文档沿用 backend 规则的生命周期元数据约定（`> 文档 ID`、`> 生命周期`、`> 最后核验`）。
- 纯 Markdown PR 使 [.github/workflows/ci.yml](../.github/workflows/ci.yml) 的 `build-test` 走 `docs_only` 快通道，跳过该任务内的构建、测试、lint 与合同检查。改动分类、`secret scan` 与 Action pin 检查仍运行。Playwright E2E 由 `web_e2e_needed` 按路径独立判定，`apps/web/`、`packages/vben/`、`packages/shared/` 和 `packages/engine-client/` 下的 Markdown 改动也会触发四路 E2E。本仓 CI 暂无 Markdown 链接机检，`lint:terms` 和 `lint:date` 的扫描范围为 UI 源码。

纯文档变更须人工核对入口链接、锚点与事实来源，也可在工作区运行跨仓只读检查，命令见 [Backend 文档自动校验](https://github.com/mlhjyx/global-backend/blob/main/docs/governance/docs-verification.md)。

## 2. 引用

- 规则正文（本机）：`/global/backend/docs/documentation-rules.md`
- 规则正文（GitHub）：[global-backend/docs/documentation-rules.md](https://github.com/mlhjyx/global-backend/blob/main/docs/documentation-rules.md)
- 跨仓文档门户（GitHub）：[global-backend/docs/README.md](https://github.com/mlhjyx/global-backend/blob/main/docs/README.md)
- 跨仓校验说明（GitHub）：[global-backend/docs/governance/docs-verification.md](https://github.com/mlhjyx/global-backend/blob/main/docs/governance/docs-verification.md)

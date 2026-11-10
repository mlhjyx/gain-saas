# 文档目录与维护规则（gain-saas）

> 文档 ID：`DOC-DOCUMENTATION-RULES-GAIN-SAAS-001`
> 生命周期：`GUIDE`
> 制定日期：2026-10-25（2026-11-04 改为单一源引用，原副本与 backend 仅一行差异且含悬空链接）
> 适用范围：gain-saas 仓的文档放置与维护。

本仓不再维护独立的文档目录规则副本。规则的唯一正文以 backend 仓 `docs/documentation-rules.md` 为准（含第 8 节「文档角色表」）；两仓规则若出现差异，以 backend 版本为准并回写本仓差异清单。

## 1. 本仓差异

- 文档根为 `docs/`，入口为 `docs/README.md`。当前目录：`prd/`、`status/`、`technical/`（含 `technical/adr/`）、`engineering/`、`evidence/`、`changelog.d/`、`superpowers/plans/`；没有 `modules/`、`shared/`、`archive/`。
- 发布顺序与阶段目标不在本仓维护；产品发布顺序的唯一来源是 backend 的 `docs/status/release-plan.md`，本仓不建 `roadmap/`。
- 本仓暂无 `docs-verification` 机器政策；新增文档沿用 backend 规则的生命周期元数据约定（`> 文档 ID`、`> 生命周期`、`> 最后核验`）。

## 2. 引用

- 规则正文（本机）：`/global/backend/docs/documentation-rules.md`
- 规则正文（GitHub）：https://github.com/mlhjyx/global-backend/blob/main/docs/documentation-rules.md

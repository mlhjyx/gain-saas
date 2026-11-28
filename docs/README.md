# gain-saas 文档导航

> 文档 ID：`DOC-PORTAL-GAIN-SAAS-001`
> 生命周期：`GUIDE`
> 最后核验：2026-11-28（以 `gain-saas@ff45fa4` 与 `backend@a5ef77f6` 核对仓内入口、跨仓权威与历史索引）。

本仓文档的唯一人类入口。当前状态、分层证据与已知缺口以 [status/current.md](status/current.md) 为准，本页只做导航，不复制状态。

## 按任务进入

| 要了解 / 要做 | 入口 | 说明 |
| --- | --- | --- |
| 现在做到哪、分层读回、下一步与阻塞 | [status/current.md](status/current.md) | 唯一当前状态页（区分路由、源码、CI、部署、页面壳与用户验收） |
| 现役 Web 产品定位、角色与导航 | [apps/web/PRODUCT.md](../apps/web/PRODUCT.md) | 现役 Vue 3 / Vben 5 / Ant Design Vue 租户产品事实与边界 |
| 产品需求（一期 PRD，含 SD1–SD17 与 §14 体验规范） | [prd/phase-1-01-04.md](prd/phase-1-01-04.md) | 2026-10-29 一期基线（`DRAFT`）；后续演进与现行口径以 status、PRODUCT 与专题为准 |
| 技术方案（一期总纲） | [technical/phase-1-01-04.md](technical/phase-1-01-04.md) | 2026-10-29 一期技术基线（`DRAFT`）；架构、事件投影、域划分与现行差异见正文注记与 status |
| 预付积分钱包 | [technical/credits-wallet.md](technical/credits-wallet.md) | 预占、按有效产出结算、退款与旧执行预算关系（实际开关与收费裁决见 status） |
| 部署与引擎事件合同 | [deploy/engine-integration.md](../deploy/engine-integration.md) | 身份、旧预算、平台调度与事件消费 |
| 引擎 OpenAPI 固定合同与升锁 | [packages/engine-client/README.md](../packages/engine-client/README.md) | 离线 pin 校验、`schema.d.ts` 生成与合同升级流程 |
| 技术专题 | [technical/](technical/) | R4 平台权威、撤销自动触发、Campaign 控制面、预算配额、邮箱域、触达 SOP 等 |
| ADR | [technical/adr/](technical/adr/) | 本仓承重决策（产品级与引擎侧 ADR 见下方跨仓入口） |
| 验收与部署证据 | [evidence/](evidence/) | 按主题分目录的历史验收与走查记录（不替代当前候选的用户验收） |
| 变更记录 | [changelog.d/](changelog.d/) | 每个改动 PR 一个片段（frontmatter `date`/`title` + 正文四段，格式同 backend 仓）；本仓暂无汇编脚本，片段作为变更记录保留 |
| 官网合作意向 API | [api/cooperation-intents.md](api/cooperation-intents.md) | 给官网前端的公开端点：字段、CORS、限流与 XSS 校验 |
| 前端发布与页面级回退 | [engineering/frontend-release-rollback.md](engineering/frontend-release-rollback.md) | 发布形态、历史深链重定向、revert 流程与演练要求 |
| Ant Design 系统 | [engineering/ui-design-system.md](engineering/ui-design-system.md) | 页面组件、反馈、响应式和测试锚点 |
| 界面设计准则 | [engineering/ui-design-guidelines.md](engineering/ui-design-guidelines.md) | 运营台与业务流程的 12 条检查项 |
| 文档放置与维护规则 | [documentation-rules.md](documentation-rules.md) | 正文以 backend 仓 `docs/documentation-rules.md` 为准，本仓只记差异 |

## 跨仓与历史权威入口

跨仓链接指向 GitHub `main`（本机对应路径附在说明中，便于跨仓核对）。

| 主题 | 权威入口 | 说明 |
| --- | --- | --- |
| 产品总设计与九模块定义 | [Global 产品总设计](https://github.com/mlhjyx/global-backend/blob/main/docs/product.md) | 本地 `/global/backend/docs/product.md`；定义九模块与共同业务对象 |
| 仓边界与承重决策 | [产品范围与边界](https://github.com/mlhjyx/global-backend/blob/main/docs/product-scope.md) · [ADR 注册表](https://github.com/mlhjyx/global-backend/blob/main/docs/adr/registry.md) | 本地 `/global/backend/docs/product-scope.md`、`docs/adr/registry.md`；现役 QGO 源码归本仓，未来宿主仍按 `PRD4-D4` 待定 |
| 发布顺序与开放冲突/决策 | [发布路线](https://github.com/mlhjyx/global-backend/blob/main/docs/status/release-plan.md) · [冲突与开放决策登记](https://github.com/mlhjyx/global-backend/blob/main/docs/governance/conflict-register.md) | 本地 `/global/backend/docs/status/release-plan.md`、`docs/governance/conflict-register.md`；含前端框架（`CON-FE-006`）、Site Builder（`PRD4-D1`）等未决项与历史替代索引 |
| 引擎当前状态、架构与证据索引 | [引擎当前状态](https://github.com/mlhjyx/global-backend/blob/main/docs/status/current.md) · [当前架构](https://github.com/mlhjyx/global-backend/blob/main/docs/architecture/current.md) · [证据索引](https://github.com/mlhjyx/global-backend/blob/main/docs/evidence/README.md) | 本地 `/global/backend/docs/{status/current.md,architecture/current.md,evidence/README.md}` |
| 文档校验规则 | [Backend 文档自动校验](https://github.com/mlhjyx/global-backend/blob/main/docs/governance/docs-verification.md) | 本地 `/global/backend/docs/governance/docs-verification.md`；含跨仓只读漂移检查说明 |
| 工作区规则与宿主机运维 | 本地 `/global/AGENTS.md`、`/global/CLAUDE.md`、`/global/local-config/RUNBOOK.md` | 仓外共享入口，开工、备份与回退按工作区根读取 |

## 约束

- 同一事实只在一个权威位置维护；本页与 README 只引用、不复制。
- 当前状态只写进 `status/current.md`；历史实施日志、过往决定与历史证据保留原文与原日期，只标注时效与 successor，不改写原件。
- 与引擎（`global/backend`）的接口真值是 `packages/engine-client/src/openapi.json` 固定的合同；文档引用 operationId，不手抄路径与总数。

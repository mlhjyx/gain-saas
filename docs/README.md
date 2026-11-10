# gain-saas 文档导航

> 文档 ID：`DOC-PORTAL-GAIN-SAAS-001`
> 生命周期：`GUIDE`
> 最后核验：2026-11-11

本仓文档的唯一人类入口。事实状态以 [status/current.md](status/current.md) 为准，本页只做导航，不复制状态。

## 按任务进入

| 要了解 / 要做 | 入口 | 说明 |
| --- | --- | --- |
| 现在做到哪、下一步与阻塞 | [status/current.md](status/current.md) | 唯一当前状态页 |
| 产品需求（一期 PRD，含 SD1–SD9 与 §14 体验规范） | [prd/phase-1-01-04.md](prd/phase-1-01-04.md) | 一期基线；后续能力以 status 与 technical 专题为准 |
| 技术方案（总） | [technical/phase-1-01-04.md](technical/phase-1-01-04.md) | 架构、域划分、部署与测试口径 |
| 技术专题 | [technical/](technical/) | R4 平台权威、撤销自动触发、Campaign 控制面、预算配额、邮箱域、触达 SOP 等 |
| ADR | [technical/adr/](technical/adr/) | 已拍板的承重决策 |
| 验收与部署证据 | [evidence/](evidence/) | 按主题分目录的真实验收记录 |
| 变更记录 | [changelog.d/](changelog.d/) | 每个改动 PR 一个片段；汇编方式同 backend 仓 |
| 前端发布与页面级回退 | [engineering/frontend-release-rollback.md](engineering/frontend-release-rollback.md) | 发布形态、revert 流程与演练要求 |
| 界面设计准则 | [engineering/ui-design-guidelines.md](engineering/ui-design-guidelines.md) | 运营台与业务流程的 12 条检查项 |
| 设计与施工计划 | [superpowers/plans/](superpowers/plans/) | 阶段计划（生命周期以文件头为准） |
| 文档放置与维护规则 | [documentation-rules.md](documentation-rules.md) | 正文以 backend 仓 `docs/documentation-rules.md` 为准 |

## 约束

- 同一事实只在一个权威位置维护；本页与 README 只引用、不复制。
- 当前状态只写进 `status/current.md`；历史实施日志按日期追加并保留原日期。
- 与引擎（`global/backend`）的接口真值是 `packages/engine-client/src/openapi.json` 固定的合同；文档引用 operationId，不手抄路径与总数。

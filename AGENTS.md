# AGENTS.md — gain-saas 稳定执行入口

本文件只保留跨会话、低漂移的工程执行规则。当前状态、在飞工作与阻塞见 [docs/status/current.md](docs/status/current.md)，文档导航见 [docs/README.md](docs/README.md)。不要把本文件扩写成状态页、设计细则或实施日志；界面设计准则在 [docs/engineering/ui-design-guidelines.md](docs/engineering/ui-design-guidelines.md)。

## 1. 权威顺序

发生冲突时按以下顺序取真：

1. 代码、数据库迁移、测试与 CI 机器合同；
2. [docs/status/current.md](docs/status/current.md)、[docs/prd/](docs/prd/)、[docs/technical/](docs/technical/)；
3. [docs/evidence/](docs/evidence/) 与 [docs/changelog.d/](docs/changelog.d/)；
4. 历史聊天、旧分支、旧 worktree、记忆。

分支、PR、worktree、服务与凭据状态都不是耐久事实；接手或状态评估前先读权威页，再对 Git/PR/服务做 live 检查。

## 2. 仓边界

- 本仓负责身份、工作空间与成员、产品页面、Campaign/QGO/SAO/Opportunity/Outcome、受控触达、运营台，以及钱包。R4 兼容模式由本仓签发平台授权；模式接线见 [引擎对接](deploy/engine-integration.md)。
- 获客引擎（`global/backend`）负责公司/买家数据、发现、身份解析、证据、联系人、资格判断与不可变 `LeadQualifiedPackage`。本仓不创建这些主状态，只经 BFF 透传租户请求、消费引擎事件。
- 与引擎的唯一代码合同是 `packages/engine-client`（固定的 OpenAPI 合同 + 生成类型）。BFF 禁止手写与引擎平行的字段定义；合同升级流程见 [packages/engine-client/README.md](packages/engine-client/README.md)。

## 3. 工作区与运行

- 先读 `/global/AGENTS.md`，再核对两仓 main 和任务 owner。在 `/global/.agy-worktrees/gain-saas/<topic>` 从已核验的提交建隔离工作树。根 checkout 跟随 main，构建产物由部署流程管理。
- systemd 托管 SaaS Web、事件 Worker 与证书端点。应用数据库、监听和回退以 [当前状态](docs/status/current.md) 与工作区 RUNBOOK 为准。调试进程使用独立端口，保留其他 worktree 和受管进程。
- 数据库迁移随 PR 前向新增，实际应用经 `prisma migrate deploy` 与部署授权。密钥只走环境或受管存储。

## 4. 开发与 PR

- 一个任务一个 writer 一个 worktree；PR 按「可独立审查、可独立回滚的逻辑变更」计数——同主题 micro 文档改动攒批，不逐文件开 PR，已开 PR 的修正追加到原 PR。
- 提交前按改动范围本地验证。`pnpm lint:terms`、`pnpm lint:date`、`pnpm --filter @gain-saas/server test`、`pnpm build`；前端改动另跑 `pnpm exec playwright test`。文档改动检查相对链接与事实来源，命令见[文档维护规则](docs/documentation-rules.md)。
- 按现行授权与 `DEC-AIDEV-004` 核对独立审查、当前 head 的必需检查与全部合并门。部署、发布和真实外部动作独立授权。清理只处理本任务且已合入的工作树，保留他人的分支和现场。
- **不手改生成物**：`packages/engine-client/src/openapi.json` 与 `schema.d.ts` 只能由 `pnpm gen:engine` 生成后提交；跨仓合同升级单独开 PR。

## 5. 界面质量

用 [界面设计准则](docs/engineering/ui-design-guidelines.md) 和 [Ant Design 实现规则](docs/engineering/ui-design-system.md)。保留表单、校验、操作、权限及错误/空状态，走查每个受改动的交互控件。业务页面沿用共用组件、语义化选择器与反馈入口。

## 6. 开发预览与验证

- 视觉迭代走独立 worktree 的 `5667` HMR。用户验收用 `pnpm preview:web` 构建并在 `5666` 预览，规划验收窗口时核对端口 owner。用户在 5666 验收通过后，再按授权进入 PR、CI、合并和部署。测试配置与构建注意事项见[前端发布与回退](docs/engineering/frontend-release-rollback.md)。
- 前端修改本地定向验证，CI 按改动范围运行其余检查。文档仅改文字时按文档快通道核对。
- Playwright 可产出截图与扫描证据；运行前核对写入路径，避免覆盖本任务外的文档。

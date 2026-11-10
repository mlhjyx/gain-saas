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

- 本仓负责 SaaS 身份/登录、工作空间与成员、Campaign/QGO/SAO/Opportunity/Outcome、受控触达、运营台，以及 R4 平台权威的签发侧（capability、机器 token、执行预算 Grant、撤销）。
- 获客引擎（`global/backend`）负责公司/买家数据、发现、身份解析、证据、联系人、资格判断与不可变 `LeadQualifiedPackage`。本仓不创建这些主状态，只经 BFF 透传租户请求、消费引擎事件。
- 与引擎的唯一代码合同是 `packages/engine-client`（固定的 OpenAPI 合同 + 生成类型）。BFF 禁止手写与引擎平行的字段定义；合同升级流程见 [packages/engine-client/README.md](packages/engine-client/README.md)。

## 3. 工作区与运行

- **根 checkout 只跟随 main**：功能修改一律在独立 worktree + 分支上做，经 PR 合入；禁止把未提交改动留在 `/global/gain-saas` 根目录。
- **系统服务唯一归属 systemd**：`gain-saas-db` / `gain-saas-web` / `gain-saas-worker` / `gain-saas-jwks-tls` 四个单元。禁止用 `nohup`/`setsid` 手工起 `node dist/main.js` 或 `dist/worker.js`，禁止与 `4020`/`5433`/`18446` 抢端口。发现端口被非 systemd 实例占用：`ss -ltnp 'sport = :4020'` + `pgrep -af` 查归属，kill 该实例让 systemd 接管。
- **构建产物由部署流程负责**：不要在根 checkout 直接 `pnpm build` 并用产物覆盖 `apps/*/dist`；发布 = 合并 `main` → CI 绿 → 部署窗口内构建并 `systemctl restart`（见 [前端发布与回退](docs/engineering/frontend-release-rollback.md)）。
- **数据库迁移**只经 `prisma migrate deploy` 应用，迁移文件随 PR 合入 `apps/server/prisma/migrations/`，只增不改；破坏性变更走 expand-and-contract。
- **密钥**只进 `.env`/环境变量；不得读取、打印或提交 token、密码、私钥。

## 4. 开发与 PR

- 一个任务一个 writer 一个 worktree；PR 按「可独立审查、可独立回滚的逻辑变更」计数——同主题 micro 文档改动攒批，不逐文件开 PR，已开 PR 的修正追加到原 PR。
- 提交前按改动范围本地验证（CI 同名检查）：`pnpm lint:terms`、`pnpm lint:date`、`pnpm --filter @gain-saas/server test`、`pnpm build`；前端改动另跑 `pnpm exec playwright test`。文档改动至少核对入口链接与术语。
- 独立自审，必需检查在当前 head 全绿后按 `DEC-AIDEV-004` 合并；部署、发布与真实外部动作是独立门。合并后删除本任务的 worktree 与本地分支。
- **不手改生成物**：`packages/engine-client/src/openapi.json` 与 `schema.d.ts` 只能由 `pnpm gen:engine` 生成后提交；跨仓合同升级单独开 PR。

## 5. 界面质量

所有用户可见界面按 [界面设计准则](docs/engineering/ui-design-guidelines.md) 执行；验收方式是让没看过文档的人独立完成主流程，而不是靠追加说明。

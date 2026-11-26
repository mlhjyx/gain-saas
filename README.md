# gain-saas（GainOS SaaS）

GainOS 的登录、企业工作空间与成员、租户 Web、受控触达、商机、运营台和预付积分钱包在本仓。获客后端通过 BFF 和事件合同对接。

## 文档入口

| 要了解 | 入口 |
| --- | --- |
| 现在做到哪、下一步与阻塞 | [docs/status/current.md](docs/status/current.md) |
| 文档导航（全部 docs） | [docs/README.md](docs/README.md) |
| 产品需求（一期 PRD，含 SD1–SD9 与 §14 体验规范） | [docs/prd/phase-1-01-04.md](docs/prd/phase-1-01-04.md) |
| 本地与部署状态 | [docs/status/current.md](docs/status/current.md) · [发布与回退](docs/engineering/frontend-release-rollback.md) |
| 积分钱包 | [docs/technical/credits-wallet.md](docs/technical/credits-wallet.md) |
| 技术方案 | [docs/technical/phase-1-01-04.md](docs/technical/phase-1-01-04.md) 与 [docs/technical/](docs/technical/) 专题 |
| 验收与部署证据 | [docs/evidence/](docs/evidence/) |
| 前端发布与页面级回退 | [docs/engineering/frontend-release-rollback.md](docs/engineering/frontend-release-rollback.md) |
| 界面设计准则 | [docs/engineering/ui-design-guidelines.md](docs/engineering/ui-design-guidelines.md) |
| 工程执行规则（Agent/协作者） | [AGENTS.md](AGENTS.md) |
| 文档放置与维护规则 | [docs/documentation-rules.md](docs/documentation-rules.md)（正文以 backend 仓为准） |

## 结构

```
apps/web                 vben SPA（租户域 + 运营域两个路由组）
apps/server              NestJS：租户域(tenant) / 运营域(ops) / 服务域(service) + web/worker 双进程
packages/shared          §14.2 术语映射 + 错误三层文案（前后端唯一真值）
packages/engine-client   引擎 OpenAPI 固定合同 + 生成类型（SD7：合同唯一入口）
packages/ops-pg          运营域服务端资产移植：PG 白名单写、fail-closed 探针、双连接池（SD9）
packages/vben            vendored vben 5（锁定 commit，见 VENDOR.md）
deploy/                  开发数据库 Compose、托管单元与引擎对接
```

## 开发

xin 上先按 [AGENTS.md](AGENTS.md) 建隔离 worktree。体验现行本机服务或做发布验收时，按[发布与回退](docs/engineering/frontend-release-rollback.md)使用既有 Web 及独立预览端口。

### xin 工作树

先核对 `git worktree list` 和任务 owner。以下示例使用已在本地存在的远端 main 对象；如对象尚不可用，先在获授权的仓库操作中取得该对象，再建工作树。

```bash
saas_task_topic=docs-example
git -C /global/gain-saas worktree list
saas_remote_main=$(git -C /global/gain-saas ls-remote --exit-code origin refs/heads/main) &&
  saas_base=${saas_remote_main%%$'\t'*} &&
  git -C /global/gain-saas cat-file -e "${saas_base}^{commit}" &&
  git -C /global/gain-saas worktree add -b "docs/$saas_task_topic" "/global/.agy-worktrees/gain-saas/$saas_task_topic" "$saas_base"
```

进入新目录，用 `git status --short --branch` 和 `git rev-parse HEAD` 确认分支与基线。

### 独立开发环境

下面的步骤用于新克隆的独立开发环境，依赖、数据库和监听均指向自己的开发实例：

```bash
corepack enable            # packageManager 字段驱动：本仓 pnpm 11，引擎仓仍 9
pnpm install --frozen-lockfile
cp .env.example .env       # 填 SESSION_SECRET / ENGINE_JWT_PRIVATE_KEY 等

docker compose -f deploy/compose.postgres.yml up -d   # 独立开发机，宿主端口 5433
pnpm db:generate && pnpm db:migrate
pnpm dev:server            # API http://127.0.0.1:4020
pnpm dev:web               # vben dev（vite），代理到 4020
```

提交前按改动范围跑 `pnpm lint:terms`、`pnpm lint:date`、`pnpm --filter @gain-saas/server test`、`pnpm build`；前端改动另跑 `pnpm exec playwright test`。PR 上的 CI 执行同名检查。

引擎 OpenAPI 合同：`pnpm gen:engine` 从运行中的引擎拉取 `/api/docs-json` 并生成 `packages/engine-client/src/{openapi.json,schema.d.ts}`。只在升级引擎合同时运行并提交生成物；CI 离线校验 `schema.d.ts` 与固定合同一致、固定合同与 `engine-contract.lock.json` 记录的哈希一致。升级与破坏性变更流程见 [packages/engine-client/README.md](packages/engine-client/README.md)。

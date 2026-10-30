# gain-saas

海外增长机会操作系统的 SaaS 平台(模块 01–04 + 平台运营域),对接获客引擎 `global/backend`。

- 产品需求:[docs/prd/phase-1-01-04.md](docs/prd/phase-1-01-04.md)(含 SD1–SD9 设计决定、§14 体验规范)
- 技术方案:[docs/technical/phase-1-01-04.md](docs/technical/phase-1-01-04.md)
- 文档规则:[docs/documentation-rules.md](docs/documentation-rules.md)

## 结构

```
apps/web          vben SPA(租户域 + 运营域两个路由组)
apps/server       NestJS:租户域(tenant)/ 运营域(ops)/ 服务域(service)+ web/worker 双进程
packages/shared   §14.2 术语映射 + 错误三层文案(前后端唯一真值)
packages/engine-client  引擎 OpenAPI 生成物(SD7:合同唯一入口,引擎启动后 pnpm gen:engine)
packages/ops-pg   中台服务端资产移植:PG 白名单写、fail-closed 探针、双连接池(SD9)
packages/vben     vendored vben 5(锁定 commit,见 VENDOR.md)
deploy/           compose(postgres)+ systemd 单元 + tailnet socket
```

## 开发

```bash
corepack enable            # packageManager 字段驱动:本仓 pnpm 11,引擎仓仍 9
pnpm install
cp .env.example .env       # 填 SESSION_SECRET / ENGINE_JWT_PRIVATE_KEY 等

docker compose -f deploy/compose.postgres.yml up -d
pnpm db:generate && pnpm db:migrate
pnpm dev:server            # API http://127.0.0.1:4020
pnpm dev:web               # vben dev(vite),代理到 4020
```

引擎 OpenAPI 生成物:引擎运行时 `pnpm gen:engine`。

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

### 5.2 Ant Design 基线（2026-11-23 增补，方案 B）

- **唯一实现路径**：登录后业务页面（`/ops`、登录/注册/异常页除外）一律使用 ant-design-vue 组件；页面级 `<style scoped>` 目标为 0 行，视觉来自 `app.vue` 的 ConfigProvider token。规范见 [界面设计系统](docs/engineering/ui-design-system.md)。
- **薄封装**：需要统一默认值时用 `apps/web/src/components/gainos/ui/`（GsPage/GsCard/GsTable/GsEmpty/GsModal/GsTag/GsStat/GsToolbar/GsSelect），不在页面里重造按钮/输入/表格/弹层。
- **薄封装必须是真组件**：封装内禁止写 `<a-card>`/`<a-tag>` 这类字符串标签（本应用没有全局注册 AntDV，会渲染成无样式自定义元素，表现为卡片 0 padding、标题/标签丢失）；必须显式 `import { Card, Tag, … }` 后用 PascalCase。
- **反馈统一**：成功/失败提示用 `#/feedback` 的 `feedback.message.*`，确认框用 `feedback.confirm`（danger 显式声明），顶部通知用 `feedback.notification.*`；禁止 `window.confirm/alert` 与静态 `message/notification`。
- **测试锚点**：页面 DOM 只承诺 role/aria-label 与 `data-gs="<area>"`；旧 BEM 页面类（`.wk__*` / `.ld__*` / `.cp__*` …）迁移后不保留，e2e 同步改写。
- **判定文本**：引擎的聚合判定（`judge-aggregate` / `C1_MATERIAL…` / `reasonCodes`）不得直接上屏；一律经 `apps/web/src/views/leads/judge.ts` 解析成五维业务语言，原文与机器码只进「技术详情」折叠区（规范 §11）。

### 5.1 简洁性（2026-11-22 增补）

目标简单，设计简单，实现简单。砍掉标语、提示文字和次要标签；如果一个页面非得靠这些东西才看得懂，那就去改布局。每个决定都要同时提升客户体验（UX）、开发者体验（DX）和智能体体验（AX），而且不能弄坏任何东西。

- 适用范围：用户登录后的系统内页面；平台运营台 `/ops` 与登录/注册页不因视觉改造而动。
- 功能守恒：可以删除装饰性标语、重复提示与次要标签；表单标签、校验规则、错误/空状态、操作入口与 API 调用不得删除。
- AX：保留语义化标题、可读的控件名称与稳定的测试锚点；不要用视觉层级替代 DOM 语义。

## 6. 开发预发与本地验证（2026-11-22 增补）

### 开发预发：用户先验收，再部署

- **dev server 是用户验收入口**：`pnpm dev:web`（端口 5666；vite.config.ts 把 `/api` 代理到本机 4020 的 gain-saas-web，走真实登录与数据；仓库无 `@vben/backend-mock` 包，nitro mock 自动跳过）。用户在 `http://127.0.0.1:5666` 验收通过后才走 PR → CI → 合并 → 部署，避免"部署到线上才发现不对"。
- **从哪跑**：改动在哪个 worktree，dev server 就从那个 worktree 启动（HMR 即时反映）；合并后需要长期预览时从根 checkout 重启。
- dev server 是开发工具，不受 systemd 约束，但**禁止占用 4020/5433/18446**（生产端口）。挂了重跑 `pnpm dev:web` 即可。
- 登录态：cookie 不分端口，用户在 4020 已登录则 5666 直接共享同一会话。

### 本地测试分层：别和 CI 重复跑全量

- 改动后本地只跑**受影响的定向 spec**（分钟级，如 nav-shell / settings-shell / cache-normalize）；全量 `pnpm e2e:nav` 交给 CI。定向本地绿 + CI 全量绿 = 通过；本地和 CI 各跑一遍全量纯属浪费（~12 分钟 ×2）。
- 纯文档/配置改动：本地 `lint:terms` + `lint:date` 过即可提 PR。
- 等 main CI 期间可预构建（server 无改动时 web-only build 只要 ~15 秒），合并后直接部署。

### 验收预发 = 生产构建预览（2026-11-23 改）

- **5666 改跑 preview**：`pnpm preview:web`（先 build，再 `vite preview --port 5666 --strictPort`；`/api` 由 `vite.config.ts` 的 `preview.proxy` 转发到 4020，登录态与真实数据不变）。原因：dev 模式冷加载是 586 个模块请求 / 约 39MB（实测本机 2.0s，经 Tailscale/LAN 会成倍放大）；preview 是单个打包产物，实测冷加载 0.5s、90 个请求，且与线上同产物。preview 是静态服务：重建后无需重启进程，用户刷新即见新版本。
- **HMR 只用于开发迭代**：另起端口跑 dev（`VITE_GLOB_API_URL= pnpm --filter @vben/web-antd exec vite --mode development --port 5667`），截图/量测用；验收结论以 5666 preview 为准。

### dev 与 preview 的渲染差异（已踩坑）

- `packages/vben` 模板里**仅靠 tailwind 工具类**隐藏/布局的元素，dev 的类名扫描范围与 build 不一致，可能出现“只在 dev 露出”的差异（实例：Vben ScrollBar 的 `hidden` 失效 → 标签栏横向滚动条）。验收以 preview 为准；这类元素在 apps 侧 CSS 用属性选择器显式兜底（如 `[data-slot='scroll-area-scrollbar']`）。

### 迭代效率约定（2026-11-23）

- 视觉迭代：一次改动 → dev HMR 截图/量测（不 build）；需求收口后才 build + preview 给用户验收。
- 测试：每轮只跑受影响 spec；全量 e2e 交 CI（后台等待，不阻塞下一步）。
- 动手前看 `uptime` 与 `ps aux --sort=-%cpu`：load > 4 时 dev 编译与浏览器渲染都会显著变慢（本机曾见 gnome-shell ~70% CPU、load 5）。

### 环境陷阱（每次建 worktree 后先做，免得白排查）

- `.env*` 是 gitignored，worktree 里没有：`cp apps/web/.env apps/web/.env.development apps/web/.env.production <worktree>/apps/web/`。缺 `.env` 会得到 `undefined-…` 偏好 namespace（缓存归一 e2e 误判）；缺 `.env.development` 则 dev 模式 apiURL 为空；**缺 `.env.production` 则构建产物 API 地址为空——Vben 把它写进 `dist/_app-config-*.js`，缺失时请求变成 `/auth/login`（无 `/api` 前缀），5666 预览直接 404（2026-11-23 用户实测登录失败）**。
- 构建产物的 API 地址来自 `dist/_app-config-*.js`（vite 插件只读 env 文件，不读进程环境变量）；改 `.env.production` 后必须重新 build 才生效。
- e2e mock 已自动去掉 `/api` 前缀匹配，带不带前缀的构建产物都能跑本地 e2e（不再需要避开根 checkout）。
- e2e 前确认 4173 无残留 preview 进程：`ss -ltnp 'sport = :4173'`，有则 kill。

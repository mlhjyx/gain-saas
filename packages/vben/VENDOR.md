# vben vendored copy(不追上游)

- 上游:https://github.com/vbenjs/vue-vben-admin(MIT)
- 锁定 commit:`4ca6b09e399c3d34e78d56afc66eda4f3cb0fe1e`(2026-10-28,v5.8.0 线)
- 引入方式:整树拷贝 `packages/`、`internal/` 与 `apps/web-antd`(→ `apps/web`);丢弃 docs、playground、scripts、turbo、其余 app 变体
- 集成:并入本仓 pnpm workspace(`packages/vben/**` globs + 原样保留 catalog/overrides/publicHoistPattern/allowBuilds)
- 变更策略:**当作 fork,不追上游升级**;仅安全修复时手动 cherry-pick 并在此登记
- 变更登记:
  - 2026-10-29 引入上游 4ca6b09e;apps/web-antd 重命名为本仓 apps/web(包名保持 `@vben/web-antd` 不变,避免改动内部导入)

## 与上游的差异清单

| 位置 | 差异 | 原因 |
| --- | --- | --- |
| apps/web(原 apps/web-antd) | 后续按 PRD §14 定制(术语、主链路页面、运营台) | 本产品需求 |
| 根配置 | 不引入 turbo/lefthook/oxlint 等上游根配置,由本仓根统一 | 单一工程约定 |
| apps/web/.env(.production) | `VITE_GLOB_API_URL=/api`(同源 BFF);标题「海外增长平台」 | 对接 gain-saas 后端 |
| apps/web/src/api/core/auth.ts | 登录/登出/权限码适配后端 Cookie 会话合同(POST /auth/login {email,password};占位 accessToken) | 后端无 Bearer token(PRD §2.3) |
| apps/web/src/api/core/user.ts | 用户信息来自 GET /auth/session 映射 vben UserInfo(realName=工作空间名) | 同上 |
| apps/web/src/api/request.ts | 信封解包拦截器(成功取 data)+ 错误取三层文案(userCopy.title/next);引擎对接未就绪(502 降级)不弹全局 toast | 后端信封 {data}/{error:{userCopy}}(PRD §14.4) |
| apps/web/src/locales/langs/{zh-CN,en-US}/gainos.json | GainOS 全量文案包(201 键 × 2,含菜单标题);两语言键名必须对齐 | SD10 双语 |
| apps/web/src/styles/gainos.css | `--gs-*` 设计令牌(浅色 + `.dark` 两套)+ 窄屏品牌标记规则 | SD10 深色模式;组件样式不得写死颜色 |
| apps/web/src/components/AuthTools.vue | 认证页右上角语言/主题切换(复用 vben 偏好与文案加载链路) | 登录/注册页需要独立切换入口 |
| apps/web/src/preferences.ts | 浅色为默认、语言/主题切换保留在顶栏、隐藏锁屏/时区/偏好抽屉、去掉标签栏与面包屑 | 产品形态(SD10) |
| apps/web/src/views/_core/authentication/* | 登录/注册整屏重设计(i18n + 令牌 + `.is-en` 英文排版作用域) | PRD §14 + SD10 |
| apps/web/index.html | 移除 vben 的品牌 meta(keywords/author)与百度统计脚本;加 GainOS 描述、浅/深两套 theme-color、三段图标链接(SVG 优先 + ICO 回退 + 触屏图标) | 产品化;不在产品里保留第三方埋点 |
| apps/web/src/assets/logo-gainos.svg | GainOS 品牌标记(几何 G,矢量唯一真值;带底板,用于浅色表面与应用图标) | 品牌 |
| apps/web/src/assets/logo-mark.svg | 同一几何的挖空版(无底板),用于深色品牌面板(登录/注册) | 深色面板上带底板的图标会糊在背景里 |
| apps/web/src/preferences.ts | `logo.source` 固定为 `/logo-gainos.svg`(public 稳定路径),不再用打包内联的 data URI | vben 会把偏好含 logo.source 持久化到 localStorage,data URI 会把旧图永久钉住 |
| apps/web/src/layouts/basic.vue | 显式传 `:logo-src` / `:logo-src-dark`,优先于持久化偏好;并移除用户下拉里的 vben 示例邮箱与「Pro」标签 | 老访客不受历史偏好影响 |
| apps/web/public/{favicon.ico,favicon.svg,apple-touch-icon.png} | 标签页/触屏图标;由 `scripts/make-icons.py` 从同一几何生成(16/32/48 + 180) | 品牌 |
| apps/web/scripts/make-icons.py | 图标位图生成器(Pillow,超采样 + 小尺寸光学微调) | 保证矢量与位图同源 |

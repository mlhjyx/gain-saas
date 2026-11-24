# SaaS 发布前置：当前主线安全集成证据

> 2026-11-23 更新。本文记录实际源码集成与已发生的实际验证，不是最终源码验收、当前 CI、部署或真实业务端到端通过。

## 基线与限定改动

正式集成基线为 `f4a4897e3ee8a082c1998d510dd96bac2b78c0c7`，保留已合入的页面、侧栏、主题、缓存和交互。原私有集成输入 `4d33b7ae7b5cdedcbfde137cc99d273133c50cfb` 的有界审查只在精确未变内容内复用，不拿旧候选结果替当前集成结果。

当前仅接入同版本 VXE 两个语言包的 es 声明导入、根安全测试接线及精确已审依赖 override/锁。effect 修至 `3.22.1`，node-forge 修至 `1.4.3`，受影响 glob 修至 `14.0.2`，minimatch 受影响线修至 `11.0.1`，旧线 postcss-selector-parser 修至 `6.1.5`。保留安全旧分支 minimatch `5.1.9` 和 parser `7.1.7`。

runs 与 workspace 页面保持主线原字节，不复贴旧空值或 unused 变量修复。新增浏览器测试按现行 identity 容器常驻、内部 span 受保护的实际 DOM 检查空值内容，不改产品迎合旧容器计数。（当时尚未运行浏览器测试；其后两轮实际运行见「实际执行结果」。）

### 主线演进说明（2026-11-23）

远端 `gain-saas` `origin/main` 已前进到 `c75f4236…`，比本任务固定基线 `f4a4897e…` 多 3 个提交，涉及 `AGENTS.md`、`apps/web/vite.config.ts`、`apps/web/e2e/locale-toggle.spec.ts`、`apps/web/src/layouts/basic.vue`（后两项为真实语言切换 reload 前的持久化修复）。主管逐路径核对本任务安全八路径在该区间无变化。

本文与任务区最终索引中的 build/type、dist、审计、默认测试及浏览器输入均基于固定 `f4a4897e…`，不代表也不可冒充 `c75f4236…` 的产物。未来正式 PR 的合成树须包含新 main 已合内容，并在该合成 head 上运行适用检查、重新表述实际输入与结果；不据此另行切换本任务基线。

## 来源和真实基线 RED

原七组件来源、官方 registry/SRI、已审实际 parent 兼容判断只对相同版本、integrity 与图身份复用。effect 的已有签名/摘要验证不等可复现构建；parser 发布者变化及无 npm provenance 限制、nonrecursive-glob-match 的源码 Git blob 对应但编译复现未证明等原限制保留，不重写为新证明。

父图锁原始 SHA-256 为 `fc41cdee659b68176de24ad28613459eb2b33083dde01f437c1b96edf93a3859`。已在本任务新空隔离 store/cache/HOME/tmp 中以官方 registry、frozen、ignore-scripts 实际物化成功，安装前后 source/lock 摘要保持，不运行 root postinstall 或其他生命周期。

先写入已审新安全回归，再在真实父图 installed inventory 上运行。实际收集并运行 23 项：16 通过、7 失败，无 skip/cancel。五类漏洞旧版本的断言真实失败，包括 effect `3.21.0`、glob `10.5.0`、minimatch `10.2.6`、node-forge `1.4.2`、parser `6.0.10`；另失败为目标新传递包尚未存在和实际 Prisma parent 仍解析旧 effect。属于目标图预期差异，不是缺模块、CLI 或收集失败。执行前后 source 字节保持、拒网日志为空。基线原始日志 SHA-256 为 `c3a8282a4badba102ccfa39969fd64ae7604f3f29ea37280ca3d5b396902a7d0`。

真实 RED 后才接入四项精确已审修复。目标锁直接复用已审正常生成的完整字节，SHA-256 为 `82c0c13f0a9d56ad66fbc3c563088473741a7da9b12717a804335f4bf6030efe`，未新解析、手改平台元数据或使用 force/latest。

## 实际执行结果（2026-11-22 至 2026-11-23）

以下均为任务私有窗口的实际记录，原件摘要见任务区最终工程索引；不据此宣称产品验收或部署通过。

- 原生版本读回：CLI 6.19.3，schema 引擎与 query 引擎均 c299…，来自本任务自有引擎副本，拒网日志为空。
- 正常客户端生成：实际退出 0，生成 canonical `.prisma/client`（schema 副本 7164…、查询引擎 a292…、client 6.19.3）。生成副本是 Prisma 格式化后的等价内容，已由独立完整词法/字面量/注释/模型属性核对确认无漂移，主管以精确材料收单作为后续 build/type 前置；旧 accepted=false 原件保留不改。
- 根 build 与根 typecheck：两条均实际退出 0（shared 14 文件、ops-pg 6、server 180、web 256；typecheck 40/41 workspace 全 Done），dist 摘要 `2a4b6de…`，源码与锁前后保持。
- 合同/类型只读检查：现行 7.13.0 CLI 以 `--check` 实际退出 0，受保护 schema.d.ts 与固定 OAS 前后字节不变，134 内部引用、0 外部引用。
- 完整官方生产审计：官方 registry，实际退出 0，info/low/moderate/high/critical 全零，生产依赖 1277、可选 237；全部严重度数据与原始 JSON 保留。
- 完整默认根测试（用户授权窗口）：实际退出 0。packages/shared 5 文件/40 用例、packages/ops-pg 1 文件/4 用例、apps/server 98 文件/826 用例全部通过；根 Node 链 39 通过、0 失败、0 跳过。隔离 PG 由未改 helper 创建并移除；只读审计对两个已删容器因 Docker 实际 “No such container” 措辞未匹配报 UNKNOWN_HOLD，主管另以 typed inspect 证明不存在；两个匿名卷已由主管按精确名称删除并复证不存在。审计卷删除能力保持 NONE。
- 选定浏览器检查（单 spec desktop，`127.0.0.1:14173`，strictPort、无复用）：实际退出 1，5 用例 4 通过、1 失败。失败为 “English workspace loads after changing the application language” 中旧的 `Overview` 标题断言：当前工作台渲染 `Today/Stage funnel/Action list`，`overviewTitle` 无页面引用，页面快照显示英文界面已正确渲染。属旧基线断言过时，不是产品缺陷。已按允许的 CREATE 路径仅改该一行断言（`Overview`→`Today`，spec 摘要 `bc09850d…`→`60b84170…`），保留英文切换、KPI 与刷新覆盖；（历史状态：当时该修订尚待复跑；其后已于 2026-11-22T18:19Z 新窗口实际执行，见下条。）

- 第二轮选定浏览器实际运行（2026-11-22T18:19Z，v8 记录驱动，新绑定窗口；首轮为 2026-11-22T15:28Z）：5 例全部通过（41.9s，含修正后的英文用例），CLI 子进程实际退出 0。但记录驱动以 66 退出、captureStatus 为 `CAPTURE_HOLD`：污染字段记录到的首个原因为 `OWN_CMDLINE_UNKNOWN:ENOENT`；按原T限定处置（d799），该证据与 stat→cmdline 退出竞态一致，但缺少 pid/start/时间/前序已知与即时复查，不能唯一证明良性退出竞态，也不能排除未记录候选；该单字段不是错误总数，未记录的重复次数不推断；当前观察不变量按 fail-closed 将已知读取失败持续视为污染。实际记录的 16 个 CLI 子树自身份全部 PROVEN_ABSENT（outer recorder 不属于该 16 表，单列为外部执行证据）、无残留、无 UNKNOWN；外部请求拒绝日志 0 字节（运行时 iconify GET 由本地 fixture 满足）；netlog 10,437,708 字节；退出后 `127.0.0.1:14173` 无监听；8 个源码与 28 个只读路径前后一致。按原T d799 限定处置：5 例可作该精确窗口真实执行成功、16 个已记录子树身份结束事实可被接纳，outer 单列；观察原因不能唯一判定，记录驱动仍为 66/CAPTURE_HOLD，原 Go COMPLETE 未满足，未重跑、未先修 observer 改写记录。
- 首轮（2026-11-22T15:28Z）运行期观察到应用自身向 `api.iconify.design` 发起 10 次图标集合请求，全部被私有出网门拒绝并记录，netlog 完整；据此准备了确定性只读图标 fixture（已装 `@iconify/json`，lucide ISC / ep MIT），仅精确服务这两条集合请求，其余外网与 WS 仍拒绝。其后第二轮窗口（2026-11-22T18:19Z）已实际使用该本地 GET fixture，外部请求拒绝日志为 0 字节。
- 记录器 v3：原技术负责人以自有副本 17 用例与五反例复跑全过，仅签署有界有限 readiness；真实服务与卷清理未含在内。

## 仍未完成与边界

- 选定浏览器修订版已在第二轮窗口实际执行，5/5 通过、CLI 退出 0；记录驱动仍为 66/CAPTURE_HOLD，原 Go 的 COMPLETE 条件未满足。旧原始记录保留，不重跑已绿用例。
- 最终新 head、当前 CI、PR、合并与部署未发生；上述实际执行不替代它们。
- 未执行：Playwright 全量/real-stack/受保护截图、真实业务 DB、模型/Grant/发送、managed runtime、部署。
- 运行期外网边界为任务私有门与浏览器级拒绝/记录，不构成 OS 级出口围栏证明。

没有改业务 API、权限/预算/重试、schema/迁移或合同 pin/types，没有真实业务 DB、R4/PKI/fence/schedule、模型、Grant、发送或部署。最终新 head、专业审查与当前 CI 仍须实际闭合。

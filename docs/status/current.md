# 当前状态与下一步

> 文档 ID:`DOC-SAAS-STATUS-001`
> 生命周期:`CURRENT`
> 事实来源:本页为主;代码与 PRD/技术方案冲突时以代码 + 评审为准
> 最后更新:2026-11-01

## 一页结论

M0–M4 的页面骨架、账户底座、BFF、线索/ICP、周报、运营台与设置页已完成。系统运行在 **http://100.68.31.20:4020**，登录、成员管理、邀请加入均为真实链路;获客引擎授权对接已完成(`verify-engine-integration.mjs` 13/13),BFF 读接口已通。**执行预算 Grant 已迁到 gain-saas 并切换引擎信任根**;运营台 `/ops` 具备独立登录域、数据源 Kill Switch、监控源 CRUD、Temporal 调度、跨租户诊断、CSV 导出与审计。**内嵌模型网关已上线并切到运行链路**(DeepSeek,默认模型 `deepseek-flash`);站点构建 settlement 读回透明代理到 new-api,客户 worker READY。

2026-10-29 晚批补齐:公司理解修复已部署,档案可到 REVIEW/ACTIVE;事件消费已实际启用并回放 297 条事件(297 条 ACK、11 条 LeadQualified),通知中心与未读角标上线;寻源任务关闭页面后可找回;企业档案增加概况/完整度/产品服务与人工事实;周报 CSV 的 withheld 响应头透传;线索包可下载,线索页支持按目标买家筛选/队列计数/管理员制裁复核;ICP 创建前校验已通过事实,已发起的寻源方案不再重复执行。运营台新增注册用户列表(工作空间/会话/最近活动)与停用/启用;客户端寻源任务页改为五段业务进度,技术统计折叠;目标买家详情属性、寻源方案来源/筛选/关键词中文化,原始查询收进技术详情;弹窗统一居中、限高滚动与移动端头部堆叠。工作空间页面补齐创建/改名/切换/退出;登录增加同 IP+邮箱 15 分钟 5 次失败的限流;企业事实支持已通过事实撤销与冲突裁决;线索页新增管理员可见的「合规待核」队列,制裁提示可直达并在档案包内复核;修复登录失败被会话过期拦截器递归触发 refresh→logout 导致按钮卡死的问题(登录/登出改走 base client,关闭 refresh-token 链路);前端 HTTP 超时从 10s 调到 240s,避免模型生成已完成但浏览器先超时、重试又撞上 Grant 复用。**仍未完成**:DSR 的 SaaS 侧级联删除、canonical 公司详情与决策人(路由已就绪,但引擎要求 `personal-data:read`,与租户红线冲突,待产品/安全决定)、禁联名单(SD5)、CSRF 自定义头、JWKS 双钥轮换、运营域 E4 写白名单执行闸与 E5 中台退役;引擎侧 ICP Grant 前置校验修复已写入工作区但未发布镜像。

## M2 交付(2026-10-29)

| 内容 | 说明 |
| --- | --- |
| GainOS 品牌 | 登录/注册页整屏重设计(分屏、网络图动效、品牌色 #00B96B、全角中文排版、移动端首屏可见表单);Logo 标记 + 应用名 GainOS |
| 信息架构 | 六项导航:工作台 / 公司档案 / 找买家 / 买家线索 / 周报 / 设置(成员与角色),对应 PRD §14.1 |
| 工作台 | 六步主链路进度(桌面完整 / 移动紧凑版)、"下一步"唯一行动、引擎状态如实降级、能力开放节奏 |
| 公司档案 | 档案列表 + 建档向导(引擎合同 `{website,name}`)、状态徽标、空态与降级态 |
| 成员与角色 | 真实可用:成员列表、邀请(生成 invitePath + 一键复制)、接受邀请注册、角色切换、移除、最后管理员保护 |
| 邀请加入 | `/auth/register?invite=...` 只设密码即加入;后端接受邀请直接下发会话(不再二次登录) |
| 阶段页 | 找买家(M3)、买家线索(M3)、周报(M4)如实标注开放节奏,不提供假交互 |
| 路由 | 切换为 history 模式(干净 URL),服务端 SPA fallback 已支持深链 |

### M2 期间修复的两个重要缺陷

1. **引擎 401 导致用户被登出**(严重):BFF 原样透传引擎 401,vben 判定为会话过期并登出。改为引擎 401/403 → **502 + "获客能力尚未完成授权对接"**文案,用户会话不受影响(已加单测锁定)。
2. **界面在深色模式下不可用**:vben 默认跟随系统深色,与浅色品牌设计冲突导致文字隐形。已固定浅色主题、去掉多余标签栏/面包屑、精简顶栏开关。

## M2.1 双语与深色模式(2026-10-29)

| 内容 | 说明 |
| --- | --- |
| 双语 | 简体中文 / English 全量覆盖(文案包 201 键 × 2,键名完全对齐);登录、注册页右上角与登录后顶栏均可切换,切换即时生效并持久化 |
| 深色模式 | 页面样式全部改用 `var(--gs-*)` 语义令牌(`src/styles/gainos.css` 浅色 + `.dark` 两套);卡片、边框、网格、品牌绿、警告/危险色各有深色取值 |
| 英文排版 | `.is-en` 作用域独立字号/字距/下划线位置;英文标题重写为两行句式,消除 "into" 孤行与占位文本截断 |
| 验收 | 8 个页面 × 中文/英文 × 浅色/深色 = 32 张实拍全矩阵核对;移动端 390px 另验深色与英文 |
| 品牌图标 | 重设计为几何 G(带切口圆环 + 圆头横杠),矢量 `src/assets/logo-gainos.svg` 与位图同源生成:`favicon.ico`(16/32/48)、`favicon.svg`(现代浏览器优先)、`apple-touch-icon.png`(180);16px 下做光学微调(放宽字怀、收细笔画) |
| 标签页清理 | `index.html` 去掉 vben 品牌 meta 与百度统计脚本;加 GainOS 描述、浅/深两套 `theme-color`、`lang="zh-CN"` |
| 标记落地 | 侧栏与登录/注册页统一使用新标记:浅色表面用带底板版(`logo-gainos.svg`),深色品牌面板用挖空版(`logo-mark.svg`);`logo.source` 改为 public 稳定路径并在布局中显式传参,修复"老访客一直看到旧 logo"的持久化钉图问题 |

### 引擎侧对接准备(2026-10-29)

| 内容 | 说明 |
| --- | --- |
| JWKS 私钥泄露(严重) | `/.well-known/jwks.json` 原先把 RSA 私钥参数(`d/p/q/dp/dq/qi`)一起公开;改为从私钥派生公钥 JWK 后只发布 `kty/n/e/kid/alg/use`,并加单测锁定。泄露的旧钥已轮换作废(`kid` → `dev-2026-10-29-b`),引擎首次信任的就是新钥 |
| 存量回放 | 引擎实际 6 个工作空间 / 382 条事件(`outbox_delivery` 279 PENDING),已登记进 `workspace_registry`;`bootstrap:backfill` 修了导入路径、根命令缺失、registry 外键缺影子 workspace 三个问题 |
| 文档纠错 | `deploy/engine-integration.md` 修正四处硬错误:`AUTH_WORKSPACE_CLAIM` 必须显式设 `workspace`(代码默认是 `workspace_id`);dev 不能走「http JWKS + https issuer」(准入拒绝);**不能用 4020 裸 http**——撤销信任复用 `AUTH_JWKS_URI` 并要求 https,否则 fence-ack 503;回填必须用 owner/BYPASSRLS(app_user 被 RLS 过滤成 0 行) |
| TLS 验签端点 | 新增 `r4-pki` 叶子 `gain-saas-jwks`(growthos-server-ca 签发,SAN `IP:127.0.0.1,DNS:localhost`)+ `deploy/systemd/gain-saas-jwks-tls.service`(socat `127.0.0.1:18446` → 4020);引擎 `AUTH_JWKS_URI`/`AUTH_ISSUER` 指向 `https://127.0.0.1:18446`,撤销信任仍为 https |
| 执行与验证脚本 | 新增 `deploy/engine-integration-apply.py`(默认 dry-run;`--apply` 证书/TLS+归档+合并 env+重建容器+R4 护栏;`--rollback` 回退)与 `deploy/verify-engine-integration.mjs`(JWKS 无私钥、三角色 token 实测、预算 JWKS、fence-ack 200、consumer 状态) |
| 执行预算 Grant 迁到 gain-saas | 2026-10-29 产品决定:不再让 GrowthOS 签 Grant。新增独立的 `ENGINE_BUDGET_GRANT_*` 钥与 `/.well-known/execution-budget-jwks.json`;BFF 对 5 条写路由先调引擎 quote 再签一次性 Grant;引擎 `EXECUTION_BUDGET_GRANT_*`(仅 `backend-runtime.env`)改指 `https://127.0.0.1:18446/execution-budget`。已用引擎 `ExecutionBudgetGrantVerifier` 预演通过(cap `5870000`、issuer/kid/scope 全匹配);`platform-worker` 的预算信任仍留 GrowthOS(R4 平台 Grant,schedules paused) |

**引擎侧已执行**(2026-10-29,root):`deploy/engine-integration-apply.py --apply` 完成 r4-pki 的 `gain-saas-jwks` 叶子 + socat TLS 端点 + env 合并 + 容器重建;`verify-engine-integration.mjs` 13/13(含预算 JWKS)。引擎只有一个 JWKS/issuer,GrowthOS(18444)签发的用户 token 已不再被接受。**执行预算 Grant 的信任根已切到 gain-saas**(`backend-runtime.env` 的 `EXECUTION_BUDGET_GRANT_JWKS_URI`/`_ISSUER`),真实 `POST /api/companies` 已完成 quote → Grant → 202 → 引擎建档 → outbox 事件。

### 本轮修复的真实缺陷

1. **整站白屏**:文案包里的 `you@company.com` 中 `@` 是 vue-i18n 的链接语法,导致整个语言包解析失败。已改为模板字面量,并在 SD10 中写成约束。
2. **i18n key 直出**:`$t('common.retry')` 缺 `gainos.` 命名空间,页面显示 `common.retry`。已全量扫描源码 key 与文案包比对,并留校验脚本思路。
3. **深色下分隔线过亮 / 网格过强**:前者漏替换一个硬编码色,后者深色下网格会读成线框稿,均已单独取值。
4. **移动端英文标语压住切换按钮、密码占位被截断**:移动端隐藏标语、缩短英文占位、窄屏降字号。

## 当前运行中(2026-10-29)

| 进程 | 启动方式 | 说明 |
| --- | --- | --- |
| 嵌入式 PostgreSQL 18.4 | `cd apps/server && nohup pnpm dev:db &` | 127.0.0.1:5433,数据在 `apps/server/data/pg`;机器重启后需重跑 |
| gain-saas web | `cd apps/server && nohup node dist/main.js &` | 0.0.0.0:4020(Tailscale 与本机均可访问);SPA + API + BFF 同源 |
| gain-saas worker | `cd apps/server && nohup node dist/worker.js &` | 事件消费(SD4)每 2 分钟一轮;`EVENT_CONSUMER_ENABLED=true`;日志 `/tmp/gain-saas-worker.log` |
| 演示账号 | owner@demo.cn / demo1234ab(admin);sales@demo.cn / member1234ab(member);newcol3@demo.cn / newcol1234ab(member) | 工作空间「宁波宏达机电有限公司」 |

正式部署(root 一次):`deploy/compose.postgres.yml` 容器替代嵌入式库 + `deploy/systemd/` 四个单元,见技术方案 §3。

## 已完成

| 里程碑 | 内容 | 证据 |
| --- | --- | --- |
| M0 | 仓库脚手架、vben 5 vendored(4ca6b09e)、Nest 三域骨架、Prisma 15 表 + 初始迁移、compose/systemd/CI | `pnpm build` 全绿;vben dist 构建成功;端点冒烟(live/jwks/login 占位/ops 503/SPA 200) |
| M1 | 注册/登录/登出/会话/工作空间切换(A1–A3、SD2、SD6 邀请码)、邀请/接受/角色变更/移除(A4,含最后管理员保护)、审计落库(A7)、BFF 路由表(SD7,错误三层映射)、事件消费完整实现(SD4:envelope/ACK/派生/游标)+ backfill 脚本、JWKS 签发 | server 37 单测;`pnpm build` 0 错误 |
| M3 | **线索工作台**:四队列 + 六步进度、真实 `GET /leads` 列表、`GET /leads/:id/package` 档案包(不含具名联系人,SD5)、accept/reject + 12 个原因码、409 阻断族三层文案、接触草稿(模型可用时查看/复制) | web 构建通过;页面空态实拍;lead 数据待真实上游模型与寻源链路验证 |
| M3 | **找买家(ICP)**:列表/创建初稿/详情(画像、买家委员会、目标市场、属性、痛点/信号/排除/价值主张)、编辑与激活、规则 CRUD + ruleLint、回测(样例 JSON)、查询计划生成/确认/执行、run 观察 | web 构建通过;ICP 生成/查询计划/执行待用真实上游模型验证 |
| M3 | **寻源任务观察独立页** `/runs/:runId`:8 段阶段条(查询/归一/Fit/网站画像/富集/信号/监控/专利预热)、按源计数与治理/错误、Fit 分布、失败阶段与错误类型、阶段产出、运行中 3s 自动刷新 | 用真实 run 结构渲染实拍(测试行已清理);PARTIAL/FAILED 显示跳过/失败阶段 |
| M4 | **周报**:目标买家/ISO 周筛选、CSV 导出(缺数据空态、withheld 计数)、反馈 CSV 原样上传(BFF `text/csv` 透传)与接受/跳过/拒绝行展示、**在线反馈表**(已接受线索逐条填写相关性/意愿/已联系/原因码/备注,POST `outcomes` 追加) | 在线反馈提交实测落库(`relevance=4`, `GOOD_FIT`, source=customer);测试数据已清理 |
| 运营端/中台 | **独立运营台** `/ops`:ops_user 独立登录域/独立 cookie、概览(引擎 ready/DB/探针/计数/红灯/失败抓取/制裁/租约/Temporal)、数据源 Kill Switch、监控源列表/详情/新建/编辑/立即抓取/状态/删除、预算账户与授权、跨租户诊断(工作空间→runs/leads/outbox/traces + 平台 fetches/changes)、Temporal 调度(列表/pause/unpause/trigger/create/delete)与获客主链路 workflow 列表、CSV 导出(sources/fetches/entities/leads)、运营审计;E1 隔离已验证 | server 37 单测通过;源创建→编辑→导出→删除与三步审计实测;调度页与源新建实拍;workflow 状态已映射为 `TIMED_OUT` 等可读值并过滤掉 site-builder 噪声 |
| 工作台 | **工作台 2.0**:按现有数据实时推导六步进度(档案→目标买家→方案→寻源→线索→周报)与下一步动作;六项业务指标(档案/目标买家/寻源/待判断/值得跟进/团队);内嵌通知中心(未读数、全部已读、点击跳转);最近线索按队列直达;多份生效中目标买家时优先展示最近真实发起过寻源的一份;"查看所有消息"深链到 `/workspace?panel=notifications`,自动滚动并高亮通知区;首次加载保留 query;线索通知与服务端链接改为直达「值得跟进」队列 | CDP 1440/390 实测:KPI 与队列计数一致、7 条通知、全部已读、线索/任务通知跳转正确、深链滚动高亮、无横向溢出 |
| 界面 | **弹窗统一**:全屏遮罩提升到 vben 顶栏/侧栏之上;ICP 详情、编辑与线索档案包改为固定头尾 + 内部滚动;企业事实审批改为事实列表单独滚动、审批栏与底部操作常驻,148 条待审事实可连续勾选;修复「编辑目标买家」白屏(文案 `attributesHint`/`backtestHint` 含未转义花括号,vue-i18n 按 ICU 解析抛错后整页渲染失败);关闭弹窗时不再产生横向滚动 | web 构建通过;CDP 在 390/768/1024/1440 四档验证 `scrollWidth === innerWidth`、编辑层渲染、148 条事实滚动与固定操作栏、线索档案包头尾固定,实拍留档 |
| 设置 | **审计**:当前操作者 tenant 审计(admin);**数据与隐私**:DSR 删除请求提交/按 id 跟踪/状态与计数回执(经 BFF 转发引擎 `/deletion-requests`),本地只存请求 id | 审计接口 200 实测;DSR 提交与查询实测返回引擎 `SUBJECT_NOT_FOUND`/`NOT_FOUND`(权限链通,非 403) |
| 模型网关 | **内嵌 OpenAI 兼容聚合网关**:运营台「模型网关」向导式配置——预制 DeepSeek/OpenAI/火山方舟/通义千问/Kimi/智谱/Ollama/自定义,选服务商后只填 API Key;「测试连接并获取模型」自动拉取上游 `/models` 并完成一次聊天探测,选一个默认模型即保存启用(自动建默认路由,所有引擎任务兜底);高级区保留按别名路由、多厂商回退、优先级/超时/额外头、调用元数据日志(不存 prompt)。上游 Key AES-256-GCM 密文落库;引擎入口 `/v1/chat/completions` 与 `/v1/models` 使用独立 Bearer;`deploy/model-gateway-apply.py` 可把引擎 api/worker 切到 `/v1` 并支持回滚。**站点构建 settlement 兼容层**:capability 本地应答,其余读回与 settled 模型调用透明代理到 new-api | 迁移 `20261029130000_ai_gateway` + `20261029140000_ai_provider_max_tokens_field`;mock 上游端到端验证:预设向导→测试自动拉模型→选默认→保存→卡片显示→更换模型/Key→保存;切换后客户 worker 曾因 settlement capability 停在 STARTING,补兼容代理后恢复 READY,`verify-engine-integration.mjs` 13/13 |

## 联系人挖掘 M4(2026-11-01,代码就绪,待引擎发车)

| 内容 | 说明 |
| --- | --- |
| BFF 路由 | `GET /canonical-companies/:id` 与 `POST …/discover-contacts`、`POST …/guess-emails`、`POST /contact-points/:id/verify` 已进路由表,全部 `access: admin`;三条写路由沿用既有预算 Grant(quote 绑定 ID/body,引擎一次性消费);缺 lawfulBasis 的引擎 403 保留为 403(不再折算成「对接未就绪」502),并有三层合规文案 |
| 决策人卡片 | 线索档案包新增「决策人」:姓名/职位/部门、联系方式与状态徽标(VALID/RISKY/PROBABLE/BLOCKED/INVALID/UNVERIFIED 照实标注)、来源链接/证据时间/证据层级(索引片段/历史档案/公开页);发现/猜测/验证三个动作都要求显式 GDPR Art.6 依据,RISKY/推断邮箱必须二次确认 |
| 未覆盖/阻塞 | ① 引擎这四个端点还要求 `personal-data:read`,该 scope 未授予任何 SaaS 角色(见 `deploy/engine-integration.md`);真实环境会 502「授权对接未就绪」,需产品/安全决定是否只给 `saas-admin` 增补,并随引擎 M1/M2 镜像发车。② 周报 CSV 的「联系路径」列仍由引擎生成,引擎周报服务明确不读 `canonical_contact`/`contact_point`;升级需引擎侧改动(BFF 不做 CSV 重写,违反 SD7 只透传) |
| 验证 | server 114 单测全过(含 Grant 接线、quote body 绑定、业务 403 映射);web typecheck/build 通过(仅剩仓库既有的 vxe-pc-ui 声明告警) |

## 下一步(按序)

1. **DSR 级联删除**:引擎删除完成后,按主体删除 SaaS `event_inbox`/`qualified_lead`/`notification`/`cost_ledger` 快照并写 `deletion_mirror`;需要先确定事件 payload 与主体的映射口径。
2. **canonical 公司详情**:引擎 `GET /canonical-companies/:id` 同时要求 `personal-data:read`(服务身份专属),租户 token 必然 403→502;需引擎提供不含个人联系人的租户详情合同,或产品决定只做列表 + 字段摘要。
3. **SD5 禁联名单**:`GET /suppressions` 要求 `personal-data:read`;需决定脱敏计数视图、仅运营台代管,或维持现状。
4. **账户与安全**:CSRF 自定义头、JWKS 双钥轮换;工作空间创建/改名/切换/退出、改密、登录限流已实现(改密和停用会撤销其他设备会话)。
5. **运营域 E4/E5**:写语句白名单目前只有登记表、没有执行闸;`acq-admin` 仍在运行,gain-saas 仍未 systemd 化。
6. **引擎侧 Grant 前置校验/草稿幂等修复**:ICP 与接触草稿的“先校验、已有草稿直接返回”改动已写入工作区并补 changelog,但未提交/发布镜像;运行中的引擎仍是旧顺序。
7. 界面收尾:顶栏 vben 偏好齿轮与重复图标行;公司手动认领仍未接(事实撤销与冲突裁决已接)。

## 已知待办(界面)

- 顶栏仍保留 vben 的「偏好设置」齿轮与重复的搜索/图标行(非 M3 引入);留待布局收尾。
- 公司档案已支持事实审批、概况/完整度/产品服务、人工补充事实、撤销与冲突裁决;仍缺手动认领。
- 禁联名单自助页受 SD5 阻塞;运营台已能看数据源/监控源与跨租户诊断。
- 新增 i18n 文案禁止直接写字面量花括号(如 `{"industry":"..."}`):vue-i18n 会按 ICU 语法解析并抛 `SyntaxError`,导致所在组件整块渲染失败;示例值放模板或用 ICU 转义。当前 `zh-CN`/`en-US` 全量文案已通过 `baseCompile` 校验。
- 寻源任务现在可从方案卡片找回;引擎侧仍没有"按 plan 列 run"的端点,恢复依赖 SaaS 本地 `discovery_run_link`。本地引用表上线前发起的 run(如 `90a3aa82…`)不会自动出现,已从引擎 `discovery_run` 回填;新 run 由"发起寻源"成功后自动登记。

## 阻塞与风险

| 项 | 说明 | 缓解 |
| --- | --- | --- |
| SD5 禁联名单读取 | 引擎 `GET /suppressions` 同时要求 `compliance:manage` 与 `personal-data:read`;后者只授事件消费服务身份,租户 token 一律 403,因此设置页无法列名单 | 产品决定:提供脱敏计数视图、仅运营台代管,或维持现状。另:BFF 把 suppressions 写路由标成 `member`,但引擎要求 `compliance:manage`,需要同步改成 admin 门 |
| GrowthOS 平台授权信任 | `EXECUTION_BUDGET_GRANT_*` 只切 api/worker;`platform-worker` 的副本仍指 GrowthOS(R4 平台 Grant/撤销,schedules paused);api 的撤销信任改用 gain-saas 预算 JWKS | 平台 schedule 仍 paused、R4 投递链未实现;回退脚本已备 |
| 重新寻源 | PRD 设计为「改目标买家 → 重新生成方案 → 人工确认 → 新 run」;当前详情页没有"重新生成方案"入口,且引擎 `icp.query_plan` 预算账户按 ICP 一次性绑定,同一 ICP 第二次生成方案会 409 `EXECUTION_BUDGET_GRANT_REUSED`;同一 plan 执行后也不能重跑(EXECUTED/账户绑定) | 需引擎把 ICP 版本或请求幂等键纳入 query-plan request scope,再补 SaaS"重新生成方案"、方案版本快照与 run 历史;期间只能由运营重置账户做一次性验证 |
| 运行方式为 nohup | 机器重启后需手动重跑两个进程(dev 阶段可接受) | 正式部署用 systemd 单元(deploy/systemd,root 一次安装) |
| 顶栏重复渲染 | vben 布局在内容区顶部重复了一行搜索/图标(工作台与线索页同样出现,非 M3 引入) | 随 M3 布局收尾处理 |

## 运行手册速查

```bash
corepack enable && pnpm install       # pnpm 11(按 packageManager 字段隔离)
cp .env.example .env                  # 填 SESSION_SECRET / ENGINE_JWT_*;EVENT_CONSUMER_ENABLED=false 直至 §2 完成
docker compose -f deploy/compose.postgres.yml up -d
pnpm db:generate && pnpm db:migrate
pnpm dev:server                        # 127.0.0.1:4020
pnpm dev:web                           # vben dev(代理到 4020)
pnpm bootstrap:backfill                # 一次性:登记引擎存量工作空间(用 ENGINE_DATABASE_URL 指向 owner,见 deploy/engine-integration.md §3)
pnpm --filter @gain-saas/server start:worker   # 事件消费(SD4)
```

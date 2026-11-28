# 当前状态与下一步

> 文档 ID:`DOC-SAAS-STATUS-001`
> 生命周期:`CURRENT`
> 事实来源:本页为主;代码与 PRD/技术方案冲突时以代码 + 评审为准
> 最后核验：2026-11-28（以 `gain-saas@ff45fa404701532785e41706dddfb9455701a50d` 与 `backend@a5ef77f64a240129c49cb14d187db40cdaae385e` 核对基线源码、运行读回与待定边界。现役导航和管理员周报接线以 `gain-saas@8964705ff0f32942f02526c99735470c97fcf56f` 为准。折叠区历史记录按原日期保留）。

## 一页结论

| 范围 | 已核对的事实（基线 `gain-saas@ff45fa4`，主线增量另标） | 限制与下一步 |
| --- | --- | --- |
| 前端栈与导航 | 现役 Web 采用 Vue 3 / Vben 5 / Ant Design Vue。主侧栏分总览（工作台、成效复盘、通知）、获客与筛选（企业档案、买家画像、寻源记录、买家线索）与整页设置（`/settings/*`）；[#261](https://github.com/mlhjyx/gain-saas/pull/261) 在主线源码将 `GROWTH_PAGE_HIDDEN` 设为 `false`，侧栏显示「触达与转化」（`/outreach`、`/opportunities`）。`ICP_ADVANCED_HIDDEN=true` 隐藏高级规则与回测，路由与重定向均保留。SaaS 租户端无 Site Builder 入口 | 现行产品说明见 [产品入口](../../apps/web/PRODUCT.md)。Next.js/React（[CON-FE-006](https://github.com/mlhjyx/global-backend/blob/main/docs/governance/conflict-register.md)）、双端改造、去租户化与 Site Builder 正式冻结（`PRD4-D1`）、租户开放范围均保持待定 |
| 管理员获客周报 | #261 主线源码在成效复盘页接入周报摘要与 CSV 下载。BFF 的 `GET /reports/weekly` 要求管理员权限 | [成效复盘页面](../../apps/web/src/views/metrics/index.vue) · [BFF 路由登记](../../apps/server/src/bff/routes.ts)。导航与周报接线均为源码事实，本页下方的部署读回仍对应原制品 |
| 注册、工作空间与角色 | 延续「一企一空间」（注册企业查重返回 409 `COMPANY_WORKSPACE_EXISTS`，`POST /api/workspaces` 410 退役，同事经邀请加入）。`#246/#249` 接通注册及接受邀请后进入工作台，启航清单按空间进度与显式 `setup=1` 展示，管理员可在清单中建档。旧 `/onboarding` 重定向至 `/workspace?setup=1`；`TenantGuard`/`BffGuard` 不再对未完成引导执行全局 409 硬拦截，改由会话、工作空间状态与 RBAC 兜底 | 变更记录见 [启航清单](../changelog.d/2026-11-27-workspace-activation.md)。`WorkspaceContext` 对 `member` 的动作声明与部分企业及资料 BFF 写路由口径不一，匿名查重响应含企业名与创建日元数据，两项均待专项裁决；新管理员与受邀成员路径尚未做本候选用户验收 |
| 企业资料与寻源任务 | 企业档案支持分片上传、续传、文档事实审阅与 UN Comtrade 选国推荐（`#251/#258`）。寻源由 SaaS `AcquisitionTasksController` 创建 `TaskRun` 并携带 legacy `taskRef` 调用引擎 `POST /query-plans/:planId/execute`（`#243` 防 202 响应覆盖已到达的终态）。固定引擎合同见 [engine-client](../../packages/engine-client/README.md) | 变更记录见 [买家旅程拆分](../changelog.d/2026-11-27-buyer-journey-and-comtrade.md)。当前引擎源码的 Discovery v3 分支使用新受理合同。v3 装配、兼容调用与终态投影须成组验证，见[引擎接入](../../deploy/engine-integration.md) |
| 事件消费、投影与 ACK | Worker 拉取引擎事件并幂等写入 `event_inbox`，按单条事件事务派生状态（失败按 1/2/4/8 分钟退避，累计 5 次或非法版本/终态转 `QUARANTINED`），再对已入箱事件批量 `POST /events/ack` 并推进游标 | **ACK 仅证明事件已入箱**，不证明派生成功、用户看到结果或钱包已结算；当前运营台缺少隔离事件查看与重放入口。寻源终态的数值 `cost` 用于技术成本投影，钱包扣点另行取证。建站累计成本摘要的生产金额为微美元字符串，SaaS 读取的 `budget.spentCents` 与之不匹配，待对账 |
| 现役 QGO、触达与合规 | QGO / SAO / CommercialOutcome 现役源码归 `gain-saas`（`/opportunities` 深链可达）。SaaS 侧 DSR 级联清理及派生回执（`DeletionCompleted` → `deletion_mirror`）与管理员只读视图（`GET /api/deletion-mirrors`、`/settings/privacy`）已接线；禁联名单已按 `admin` + 引擎 `compliance:manage` 接线到 `/settings/suppressions`。读取范围为当前工作空间，发送预检另查平台全局禁联。SaaS 对接角色映射的 `personal-data:read` 仅授事件消费服务身份。触达代码默认 `OUTREACH_SEND_ENABLED=false`、`CAMPAIGN_EXECUTION_SHADOW=true`，队列另有 `OUTREACH_SENDER_ENABLED`，发送受管理员与批次授权门约束 | QGO 未来宿主仍待 [PRD4-D4](https://github.com/mlhjyx/global-backend/blob/main/docs/governance/conflict-register.md)。现网触达实际开关未知；正式发信、授权、回复停发与快捷确认边界、以及 T0 打开外链即记 `contacted: true` 的口径均待专项裁决 |
| 钱包与旧执行预算 | `#247` 已将共用任务入口接入钱包预占与 `DiscoveryRunCompleted` 结算，`#255` 增加可配置新企业注册赠点；代码默认 `WALLET_BILLING_ENABLED=false`、`WALLET_SIGNUP_BONUS_CREDITS=0`、`WALLET_HOLD_SWEEP_ENABLED=false`。旧预算 `bypass` 或关闭强制配额时（`#245`）停发并隐藏旧额度提醒 | 接线见 [钱包说明](../technical/credits-wallet.md) 与 [配额说明](../technical/workspace-budget-quota.md#旧提醒与通知列表)。**现网钱包开关状态未知**，不得把代码默认值写成运行状态；正式收费、价目缺失策略与不明受理预占对齐均保持待定 |

## 分层证据与本机读回（2026-11-28 CST）

以下按证据层分开记录，不把下层结果推导为上层通过。

| 证据层 | 2026-11-28 读回事实 | 证明范围与未覆盖部分 |
| --- | --- | --- |
| 基线路由（`ff45fa4`） | 租户 Web 路由在 `apps/web/src/router/routes/`：总览（`/workspace`、`/analytics`、`/notifications`）、获客与筛选（`/companies`、`/find-buyers`、`/tasks`、`/leads`）、隐藏的触达与转化（`/outreach`、`/opportunities`，`GROWTH_PAGE_HIDDEN=true`）、整页设置（`/settings/{account,members,suppressions,sources,privacy,audit,outreach-mailboxes}`）及 `/onboarding` 重定向；无 Site Builder 路由。服务端通用 BFF 路由与角色声明见 [BFF 路由登记](../../apps/server/src/bff/routes.ts)，另有独立租户、任务、钱包、商机、触达与 `/ops` 运营控制器 | 该行记录原基线的路由定义及权限声明。#261 的主线导航更新见一页结论，部署与端到端结果分别取证 |
| 源码与离线检查 | 固定基线 `gain-saas@ff45fa404701532785e41706dddfb9455701a50d`、`backend@a5ef77f64a240129c49cb14d187db40cdaae385e`。固定合同锁 [engine-contract.lock.json](../../packages/engine-client/engine-contract.lock.json) 指向 `backend@98bc65ee`（2026-11-27）；只读运行 `verify-pin.mjs`、`lint-forbidden-terms.mjs`、`lint-date-format.mjs`、`check-action-pins.mjs` 与跨仓 `docs-drift-report.mjs` 均退出 0 | 证明源码约束与合同字节一致；未在只读核验中重跑全量单测、PG 集成测试或 E2E |
| CI 状态 | `gain-saas@ff45fa4` 在 GitHub CI 读取 8 项通过（含 `e2e` 汇总及 4 路 BFF-mock Playwright 分片）；main ruleset `27093506` 强制 `build · test · contract` 与 `secret scan`（审批数为 0）。纯 Markdown PR 的 `build-test` 走 `docs_only` 快通道，E2E 按路径单独判定，见 [CI 核验范围](../documentation-rules.md)。本仓 CI 暂无 Markdown 链接机检。同期 `backend@a5ef77f6` 的 main push CI 有 2 项失败（`postgres semantics · permissions` 断言 native Discovery v3 厂家证据计数失败及汇总检查），其容器镜像发布检查单独通过 | 证明本提交在托管 CI 跑过对应检查；SaaS mock E2E 不证明真栈或认证后业务结果，后端 main CI 失败原因待查 |
| 本机部署读回 | 本机回读 `gain-saas-web.service`、`gain-saas-worker.service` 为 `active/running`，单元启动时间为 **04:45:01 CST**，均指向制品 `gain-saas-ff45fa4-20261128`（`COMMIT=ff45fa404701532785e41706dddfb9455701a50d`）；**05:36 CST** 核对入口摘要：`main.js` 为 `a937a70d…`、`worker.js` 为 `d5977d94…`。<br>**05:05:30 CST**：Backend 三容器运行且 healthy，OCI revision `a5ef77f6…`，镜像 `sha256:50b3ff38…`，`/health/build` attested，`migration_revision=20261127180000_google_places_discovery_provider`，API readiness `200/ready`。**05:33 CST** 复核 readiness 为 `200/ready` 且 16 个硬组件均 `ok`。<br>**05:27 CST**：Web 单元已无旧 DB 依赖，Worker 单元仍保留对 `gain-saas-db.service`（`active/running`、`disabled`）的 `Wants/After`；备份与巡检 timer 为 `active/waiting`。<br>**05:32 CST**：`GET /api/auth/registration-policy` 返回 200，`inviteCodeRequired=false`。<br>**05:33 CST**：SaaS `GET /health/ready` 返回 `200/ok`（`db=true`、`engine=true`、`event_consumer=true`、`legacy_execution_budget_mode=bypass`、`platform_authority_mode=r4`） | 仅证明观测时点本机进程、制品身份与基础存活。SaaS readiness 只探引擎 `/api/v1/health/live` 且降级在 body 表达（HTTP 仍可 200）。**未读回（未知）**：现网 `WALLET_BILLING_ENABLED`、注册赠点与触达各开关值、引擎执行预算一致性、事件隔离积压、Worker 旧 DB 实际连接去向、备份内容与恢复能力 |
| 页面壳读回 | 本机 `/`、`/auth/login`、`/runs` 返回 `HTTP 200 text/html`，正文 SHA-256 与制品 `apps/web/dist/index.html` 一致；**05:36 CST** 核对页面壳引用的 15 项本地脚本、预加载与样式资源均返回 `HTTP 200` 且摘要吻合制品 | 仅证明静态 SPA 外壳与资源文件送达。该步骤未执行浏览器登录、JS 交互或认证后的业务调用 |
| 用户验收 | **本候选（`ff45fa4` + `a5ef77f6`）尚未执行正常用户端到端验收** | 注册/邀请、企业资料上传、寻源任务与恢复、终态与人工接受、QGO/触达/钱包结算等九条旅程均待独立验收；真实外发、收费与恢复均未验证 |

旧预算旁路、钱包启用、触达开关与 R4 切换分别配置。[引擎对接](../../deploy/engine-integration.md)与[发布手册](../engineering/frontend-release-rollback.md)记录操作前提和回退，本页不复写细则。

## 待定决策与后续裁决项

以下事项保持待定或待独立裁决，本页不推定已批准、已开启或可商用：

| 事项 | 当前状态 | 关联依据与边界 |
| --- | --- | --- |
| 正式发信与触达授权 | 待定（实际开关未核验） | 代码默认关闭真实发信并开启影子模式，实际环境开关未知；回复停发与取消队列状态一致性、独立批次停止、快捷确认及 T0 打开即记 `contacted` 待专项裁决与替身零外发验收 |
| 商业收费与钱包正式规则 | 待定（开关未知） | 代码默认 `WALLET_BILLING_ENABLED=false`，实际环境开关未知；不明受理预占在通用 BFF 与任务路由上的差异、价目缺失按免费返回、超期预占释放与迟到事件待对齐，商业定价与收费需产品负责人批准 |
| Discovery v3 切换与合同升锁 | 待定 | 固定合同比引擎源码早；后端 v3 分支拒收 legacy `taskRef`，存在 API runtime 绑定、`QUEUED` 终态投影与非模型成本覆盖缺口，且后端 main push CI 存在未排查失败 |
| 成员写权限、匿名查重披露与运营 DB 写闸 | 待专项裁决 | `WorkspaceContext` `member` 动作声明与 BFF 写路由口径不一；重复注册响应返回企业名与创建日；`packages/ops-pg` `ownerQuery` 尚未强制应用白名单（同时承担合法平台只读）；健康探针口径（Backend/SaaS/Ops）待统一 |
| QGO 未来宿主 | 待定（`PRD4-D4`） | 现役源码与主状态归 `gain-saas`；未来宿主维持 [ADR-001](https://github.com/mlhjyx/global-backend/blob/main/docs/adr/registry.md) 与 [PRD4-D4](https://github.com/mlhjyx/global-backend/blob/main/docs/governance/conflict-register.md) 登记，待单独裁决 |
| Site Builder | 冻结、开放范围各自待定 | SaaS 租户端无用户入口。正式冻结见 `PRD4-D1`，SaaS 开放范围后续另定 |
| 未来前端框架、双端改造与去租户化 | 待定（`CON-FE-006`） | 现役保持 Vue 3 / Vben 5 / Ant Design Vue 与一企一空间；Next.js/React、双端改造与去租户化均待后续提案审批 |

<details>
<summary>2026-10 至 11 月的交付与运行记录（历史快照，按原日期保留）</summary>

> 时效与承接说明（2026-11-28）：本折叠区保留 2026-10-29 至 2026-11-27 的历史交付与运行读数原文，不回写当时事实。其中已由新源码或新读回替代的项目包括：
> - 2026-11-27 运行读回（`gain-saas-439e4247-20261127`）与 2026-11-11 运行读数（`5433` 嵌入式库）已由上方 **2026-11-28 分层读回**（`gain-saas-ff45fa4-20261128`）替代；
> - 2026-10-29 标注的「仍缺 DSR 的 SaaS 侧级联删除」与「禁联名单受 SD5 阻塞」已在 `ff45fa4` 源码接线（DSR 级联写入 `deletion_mirror` 并接 `/settings/privacy`，引擎 `GET /suppressions` 仅要求 `compliance:manage`，SaaS BFF 全部 5 条禁联路由已限 `admin` 并接 `/settings/suppressions`）；
> - 其余未关闭项（如 `ops-pg` `ownerQuery` 白名单执行闸、未完成的真实用户验收）已汇总到上方当前表与待裁决表。

### xin 运行回读（2026-11-27，历史）

- SaaS `GET /health/ready` 返回 200，回读旧预算 `bypass`、平台权威 `r4`。生产宿主运行形态按部署窗口复核。
- 已核对 Web 与 Worker 连接 `127.0.0.1:5432` 的当前 PostgreSQL 服务，旧 `gain-saas-db.service` 仍在 `5433` 监听，单元为 active/disabled。本机日常恢复与旧库回退读工作区 RUNBOOK §13。
- `#243` 服务端入口为 `releases/gain-saas-439e4247-20261127`，部署记录说明沿用原 SPA。主线后续的 `#244` 需有单独的前端部署证据。
- 旧预算旁路、钱包启用与 R4 切换分别配置。[引擎对接](../../deploy/engine-integration.md)与[发布手册](../engineering/frontend-release-rollback.md)记录操作前提和回退。

## 2026-11-21 一企一空间(产品决策落地)

- 产品拍板「单位是企业」:工作空间=企业组织,一企一空间。注册含企业查重硬拦截(名称归一化精确/包含命中即 409 `COMPANY_WORKSPACE_EXISTS`,引导邀请加入);同事经「设置 → 成员」邀请链接加入,不建新空间。
- `POST /workspaces` 自助创建退役为 410;`switch-workspace` 服务端保留(membership 驱动,无 UI)。
- 存量收编脚本 `pnpm --filter @gain-saas/server bootstrap:consolidate`(dry-run 默认):重复组按业务数据量选保留侧,空侧成员先补保留侧再归档;测试/验收空间与 0 成员孤儿归档停轮询;双侧有数据的组标 `NEEDS_MANUAL` 留引擎专项;全程不物理删行。
- PRD §4 A1/A3、§5.3 已同步改写。

## 2026-11-17 官网合作意向入口(产品 + 工程)

- 官网「提交合作意向」表单接入公开端点 `POST /api/public/cooperation-intents`(无登录态、CORS 可配、16KB 体积上限、IP/邮箱双维度限流、字段级 XSS 清洗),线索落本仓 `cooperation_intent`。
- 运营台 `/ops` 新增「合作意向」页:按状态筛选、查看填写内容、标记已联系/关闭/重开、跟进备注(写操作进审计)。
- 对接文档:`docs/api/cooperation-intents.md`;迁移 `20261117120000_cooperation_intent`;配置 `PUBLIC_COOPERATION_ALLOWED_ORIGINS`(默认 `*`)。

## 2026-11-11 CI 与文档入口治理(工程,无产品行为变化)

- **CI(#155)**:纯文档 PR 走 `classify` 快通道——只跑改动分类与新增的 gitleaks 密钥扫描,跳过 build/test/E2E 与契约门;代码 PR 检查不变。引擎合同改为离线确定性校验:`packages/engine-client/engine-contract.lock.json` 固定合同的 SHA-256,CI 校验 `schema.d.ts` 与固定合同一致;合同变更的 PR 对 base 分支合同跑 oasdiff breaking(`engine-contract-breaking-approved` label 放行),CI 不再依赖运行中的引擎实例。
- **文档(#154)**:README / AGENTS / `docs/README.md` 重建为当前产品现实的入口;UI 设计准则移入 [engineering/ui-design-guidelines.md](../engineering/ui-design-guidelines.md);当时的运行方式见下方 2026-11-11 历史读数。

## P9 平台撤销自动触发(2026-11-01,已实现,默认关闭)

撤销链的发起方已补齐:政策停用(`R4_PLATFORM_POLICY_MODES` 镜像 + `r4_platform_policy_state`)、部署绑定显式撤销(`revokedAt`)、运营台「平台撤销」页。模型为逻辑请求 + 追加式尝试:同一命令原字节重放,ACK 验签后才记成功,缺 ACK 不判未提交,`SEQUENCE_CONFLICT` 停住等人工;没有 live Grant 时记 `NO_LIVE_TARGET`(不挂起、不阻塞 capability)。Grant 签发与 capability 在策略停用/未结撤销/绑定被显式撤销时 fail closed。**默认关闭**(`R4_REVOCATION_TRIGGER_ENABLED=false`、`R4_REVOCATION_AUTO_CONFIRM=false`)。dev 线上在 2026-11-01 测试窗口开启并完成真实撤销闭环实测(绑定撤销→自动请求→真实 Grant 投递→fence→ACK→受审计重开;证据见 global-backend `docs/evidence/2026-11-01-platform-revocation-autotrigger-live.md`),**生产未启用**。实现与运维说明见 [technical/r4-revocation-autotrigger.md](../technical/r4-revocation-autotrigger.md),设计见 global-backend `docs/superpowers/plans/2026-11-01-platform-revocation-autotrigger.md`。2026-11-03 运营台适配:开关真实状态(启用/自动确认)随 `GET /api/ops/r4/policy-state` 返回并在页面显示,「发起/确认/取消」在未启用时禁用;撤销列表补投递结果未知标记、尝试次数与最近尝试结果,状态/来源/原因改中文标签(原码保留);概览红灯新增未结撤销、投递结果未知、平台授权轮次耗尽。该验证窗口的 `R4_REVOCATION_TRIGGER_ENABLED/AUTO_CONFIRM=true` 为测试临时值,测试结束按本文回退为 false/false。

### 2026-10-29 交付读数（历史）

M0–M4 的页面骨架、账户底座、BFF、线索/ICP、周报、运营台与设置页已完成。系统运行在 **http://100.68.31.20:4020**，登录、成员管理、邀请加入均为真实链路;获客引擎授权对接已完成(`verify-engine-integration.mjs` 13/13),BFF 读接口已通。**执行预算 Grant 已迁到 gain-saas 并切换引擎信任根**;运营台 `/ops` 具备独立登录域、数据源 Kill Switch、监控源 CRUD、Temporal 调度、跨租户诊断、CSV 导出与审计。**获客模型网关保持 new-api**(2026-11-03 产品决定:引擎 `MODEL_GATEWAY_URL` 继续指向 new-api,任务级模型由引擎 `MODEL_ACQUISITION_TASK_MODELS` 控制);运营台的「模型网关」管理界面与 API 已移除,gain-saas 保留 `/v1` 兼容入口与站点构建 settlement 读回代理,客户 worker READY。

2026-10-29 晚批补齐:公司理解修复已部署,档案可到 REVIEW/ACTIVE;事件消费已实际启用并回放 297 条事件(297 条 ACK、11 条 LeadQualified),通知中心与未读角标上线;寻源任务关闭页面后可找回;企业档案增加概况/完整度/产品服务与人工事实;周报 CSV 的 withheld 响应头透传;线索包可下载,线索页支持按目标买家筛选/队列计数/管理员制裁复核;ICP 创建前校验已通过事实,已发起的寻源方案不再重复执行。运营台新增注册用户列表(工作空间/会话/最近活动)与停用/启用;客户端寻源任务页改为五段业务进度,技术统计折叠;目标买家详情属性、寻源方案来源/筛选/关键词中文化,原始查询收进技术详情;弹窗统一居中、限高滚动与移动端头部堆叠。工作空间页面补齐创建/改名/切换/退出;登录增加同 IP+邮箱 15 分钟 5 次失败的限流;企业事实支持已通过事实撤销与冲突裁决;线索页新增管理员可见的「合规待核」队列,制裁提示可直达并在档案包内复核;修复登录失败被会话过期拦截器递归触发 refresh→logout 导致按钮卡死的问题(登录/登出改走 base client,关闭 refresh-token 链路);前端 HTTP 超时从 10s 调到 240s,避免模型生成已完成但浏览器先超时、重试又撞上 Grant 复用。**仍未完成**:DSR 的 SaaS 侧级联删除、禁联名单(SD5)、CSRF 自定义头、JWKS 双钥轮换、运营域 E4 写白名单执行闸与 E5 中台退役(引擎侧 Grant 前置校验/草稿幂等已由 #699 于 2026-10-30 补齐)。(canonical 公司详情与决策人已对管理员上线,见「联系人挖掘 M4」;`personal-data:read` 仍不授任何用户角色。)

## M2 交付(2026-10-29)

| 内容 | 说明 |
| --- | --- |
| GainOS 品牌 | 登录/注册页整屏重设计(分屏、网络图动效、品牌色 #00B96B、全角中文排版、移动端首屏可见表单);Logo 标记 + 应用名 GainOS |
| 信息架构 | 六项导航:工作台 / 公司档案 / 找买家 / 买家线索 / 商机与触达 / 设置(成员与角色)(P6 后口径;周报已于 2026-11-11 取消) |
| 工作台 | 六步主链路进度(桌面完整 / 移动紧凑版)、"下一步"唯一行动、引擎状态如实降级、能力开放节奏 |
| 公司档案 | 档案列表 + 建档向导(引擎合同 `{website,name}`)、状态徽标、空态与降级态 |
| 成员与角色 | 真实可用:成员列表、邀请(生成 invitePath + 一键复制)、接受邀请注册、角色切换、移除、最后管理员保护 |
| 邀请加入 | `/auth/register?invite=...` 只设密码即加入;后端接受邀请直接下发会话(不再二次登录) |
| 阶段页 | 找买家(M3)、买家线索(M3)如实标注开放节奏,不提供假交互(周报 M4 已于 2026-11-11 取消) |
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
| TLS 验签端点 | 新增 `r4-pki` 叶子 `gain-saas-jwks`（`growthos-server-ca` 签发，SAN `IP:127.0.0.1,IP:172.20.0.1,DNS:localhost`，供 `18446` 与 `172.20.0.1:18447/18448` 复用）+ `deploy/systemd/gain-saas-jwks-tls.service`（socat `127.0.0.1:18446` → 4020）；引擎 `AUTH_JWKS_URI`/`AUTH_ISSUER` 指向 `https://127.0.0.1:18446`，撤销信任仍为 https |
| 执行与验证脚本 | 新增 `deploy/engine-integration-apply.py`(默认 dry-run;`--apply` 证书/TLS+归档+合并 env+重建容器+R4 护栏;`--rollback` 回退)与 `deploy/verify-engine-integration.mjs`(JWKS 无私钥、三角色 token 实测、预算 JWKS、fence-ack 200、consumer 状态) |
| 执行预算 Grant 迁到 gain-saas | 2026-10-29 产品决定:不再让 GrowthOS 签 Grant。新增独立的 `ENGINE_BUDGET_GRANT_*` 钥与 `/.well-known/execution-budget-jwks.json`;BFF 对 5 条写路由先调引擎 quote 再签一次性 Grant;引擎 `EXECUTION_BUDGET_GRANT_*`(仅 `backend-runtime.env`)改指 `https://127.0.0.1:18446/execution-budget`。已用引擎 `ExecutionBudgetGrantVerifier` 预演通过(cap `5870000`、issuer/kid/scope 全匹配);`platform-worker` 的预算信任仍留 GrowthOS(R4 平台 Grant,schedules paused) |

**引擎侧已执行**(2026-10-29,root):`deploy/engine-integration-apply.py --apply` 完成 r4-pki 的 `gain-saas-jwks` 叶子 + socat TLS 端点 + env 合并 + 容器重建;`verify-engine-integration.mjs` 13/13(含预算 JWKS)。引擎只有一个 JWKS/issuer,GrowthOS(18444)签发的用户 token 已不再被接受。**执行预算 Grant 的信任根已切到 gain-saas**(`backend-runtime.env` 的 `EXECUTION_BUDGET_GRANT_JWKS_URI`/`_ISSUER`),真实 `POST /api/companies` 已完成 quote → Grant → 202 → 引擎建档 → outbox 事件。

### 本轮修复的真实缺陷

1. **整站白屏**:文案包里的 `you@company.com` 中 `@` 是 vue-i18n 的链接语法,导致整个语言包解析失败。已改为模板字面量,并在 SD10 中写成约束。
2. **i18n key 直出**:`$t('common.retry')` 缺 `gainos.` 命名空间,页面显示 `common.retry`。已全量扫描源码 key 与文案包比对,并留校验脚本思路。
3. **深色下分隔线过亮 / 网格过强**:前者漏替换一个硬编码色,后者深色下网格会读成线框稿,均已单独取值。
4. **移动端英文标语压住切换按钮、密码占位被截断**:移动端隐藏标语、缩短英文占位、窄屏降字号。

## 当前运行中(2026-11-11 实测)

| systemd 单元 | 说明 |
| --- | --- |
| `gain-saas-db.service` | 嵌入式 PostgreSQL 18(`127.0.0.1:5433`),数据在 `apps/server/data/pg` |
| `gain-saas-web.service` | web + API + BFF 同源(`0.0.0.0:4020`,Tailscale 与本机可访问),`Restart=always` |
| `gain-saas-worker.service` | 事件消费(SD4,每 2 分钟一轮;`EVENT_CONSUMER_ENABLED=true`) |
| `gain-saas-jwks-tls.service` | 引擎验签用 JWKS TLS 端点(`127.0.0.1:18446` → 4020) |

四个单元均 `enabled`;排障用 `systemctl status <unit>` 与 `journalctl -u <unit>`,**禁止用 `nohup`/`setsid` 手工起进程**(会与 systemd 抢端口,2026-11-02/03 曾因此触发 web 崩溃循环)。演示账号是本地 dev fixture,凭据不入库。发布流程见 [engineering/frontend-release-rollback.md](../engineering/frontend-release-rollback.md)。

## 已完成

| 里程碑 | 内容 | 证据 |
| --- | --- | --- |
| M0 | 仓库脚手架、vben 5 vendored(4ca6b09e)、Nest 三域骨架、Prisma 15 表 + 初始迁移、compose/systemd/CI | `pnpm build` 全绿;vben dist 构建成功;端点冒烟(live/jwks/login 占位/ops 503/SPA 200) |
| M1 | 注册/登录/登出/会话/工作空间切换(A1–A3、SD2、SD6 邀请码)、邀请/接受/角色变更/移除(A4,含最后管理员保护)、审计落库(A7)、BFF 路由表(SD7,错误三层映射)、事件消费完整实现(SD4:envelope/ACK/派生/游标)+ backfill 脚本、JWKS 签发 | server 37 单测;`pnpm build` 0 错误 |
| M3 | **线索工作台**:四队列 + 六步进度、真实 `GET /leads` 列表、`GET /leads/:id/package` 档案包(不含具名联系人,SD5)、accept/reject + 12 个原因码、409 阻断族三层文案、接触草稿(模型可用时查看/复制) | web 构建通过;页面空态实拍;lead 数据待真实上游模型与寻源链路验证 |
| M3 | **找买家(ICP)**:列表/创建初稿/详情(画像、买家委员会、目标市场、属性、痛点/信号/排除/价值主张)、编辑与激活、规则 CRUD + ruleLint、回测(样例 JSON)、查询计划生成/确认/执行、run 观察 | web 构建通过;ICP 生成/查询计划/执行待用真实上游模型验证 |
| M3 | **寻源任务观察独立页** `/runs/:runId`:9 段阶段条(查询/归一/Fit/网站画像/富集/信号/联系人发现/监控/专利预热)、按源计数与治理/错误、Fit 分布、失败阶段与错误类型、阶段产出、运行中 3s 自动刷新 | 用真实 run 结构渲染实拍(测试行已清理);PARTIAL/FAILED 显示跳过/失败阶段 |
| M4 | ~~**周报**~~(**2026-11-11 功能取消**,历史见下):原目标买家/ISO 周筛选、CSV 导出(withheld 计数)、反馈 CSV 原样上传与在线反馈表 | 上线期间实测落库(`relevance=4`, `GOOD_FIT`);下线后 `/reports` 路由、BFF 透传与页面已移除 |
| 运营端/中台 | **独立运营台** `/ops`:ops_user 独立登录域/独立 cookie、概览(引擎 ready/DB/探针/计数/红灯/失败抓取/制裁/租约/Temporal)、数据源 Kill Switch、监控源列表/详情/新建/编辑/立即抓取/状态/删除、预算账户与授权、跨租户诊断(工作空间→runs/leads/outbox/traces + 平台 fetches/changes)、Temporal 调度(列表/pause/unpause/trigger/create/delete)与获客主链路 workflow 列表、CSV 导出(sources/fetches/entities/leads)、运营审计;E1 隔离已验证 | server 37 单测通过;源创建→编辑→导出→删除与三步审计实测;调度页与源新建实拍;workflow 状态已映射为 `TIMED_OUT` 等可读值并过滤掉 site-builder 噪声 |
| 工作台 | **工作台 2.0**:按现有数据实时推导五步进度(档案→目标买家→方案→寻源→线索)与下一步动作(周报 2026-11-11 取消);六项业务指标(档案/目标买家/寻源/待判断/值得跟进/团队);内嵌通知中心(未读数、全部已读、点击跳转);最近线索按队列直达;多份生效中目标买家时优先展示最近真实发起过寻源的一份;"查看所有消息"深链到 `/workspace?panel=notifications`,自动滚动并高亮通知区;首次加载保留 query;线索通知与服务端链接改为直达「值得跟进」队列 | CDP 1440/390 实测:KPI 与队列计数一致、7 条通知、全部已读、线索/任务通知跳转正确、深链滚动高亮、无横向溢出 |
| 界面 | **弹窗统一**:全屏遮罩提升到 vben 顶栏/侧栏之上;ICP 详情、编辑与线索档案包改为固定头尾 + 内部滚动;企业事实审批改为事实列表单独滚动、审批栏与底部操作常驻,148 条待审事实可连续勾选;修复「编辑目标买家」白屏(文案 `attributesHint`/`backtestHint` 含未转义花括号,vue-i18n 按 ICU 解析抛错后整页渲染失败);关闭弹窗时不再产生横向滚动 | web 构建通过;CDP 在 390/768/1024/1440 四档验证 `scrollWidth === innerWidth`、编辑层渲染、148 条事实滚动与固定操作栏、线索档案包头尾固定,实拍留档 |
| 启动页 | **品牌启动页重做**:柔光品牌绿 + 淡网格背景、孔径静态光圈 / 双层脉冲 / 绕行扫描弧、两段式字标、无确定感扫描条与状态点、底部编辑式元信息;深浅色、移动端、横屏与 `prefers-reduced-motion` 全适配;修复 `%VITE_APP_TITLE%` 未替换的占位标题与侧栏应用名回落 Vben Admin | CDP 实拍 390/768/1440/844×390/1024×600 与深色;`prefers-reduced-motion` 下动画归零且启动页仍正常卸载;`scrollWidth === innerWidth`;首帧底色内联避免白闪 |
| 设置 | **审计**:当前操作者 tenant 审计(admin);**数据与隐私**:DSR 删除请求提交/按 id 跟踪/状态与计数回执(经 BFF 转发引擎 `/deletion-requests`),本地只存请求 id | 审计接口 200 实测;DSR 提交与查询实测返回引擎 `SUBJECT_NOT_FOUND`/`NOT_FOUND`(权限链通,非 403) |
| 模型网关 | 2026-10-29 曾在运营台上线「模型网关」管理界面(厂商/别名路由/测试/调用记录);**2026-11-03 产品决定保持 new-api 作为引擎网关**,该管理界面与 `/api/ops/model-gateway/*` API 已整体移除。gain-saas 保留:`/v1/chat/completions`、`/v1/models` 兼容入口(独立 Bearer)与站点构建 settlement 读回兼容代理(`/api/settlement-readback/*` 本地 capability + settled 调用透传 new-api);`deploy/model-gateway-apply.py` 在当前决策下不要执行(会把引擎切到无管理面的 4020) | 移除后 server 161 单测全过;`/api/ops/model-gateway` 404、`/v1/models` 401(入口保留)、settlement capability 本地应答 200 |

## 联系人挖掘 M4(2026-11-02 已上线 dev,管理员 UAT 通过)

| 内容 | 说明 |
| --- | --- |
| BFF 路由 | `GET /canonical-companies/:id` 与 `POST …/discover-contacts`、`POST …/guess-emails`、`POST /contact-points/:id/verify` 已进路由表,全部 `access: admin`;三条写路由沿用既有预算 Grant(quote 绑定 ID/body,引擎一次性消费);缺 lawfulBasis 的引擎 403 保留为 403(不再折算成「对接未就绪」502),并有三层合规文案 |
| 决策人卡片 | 线索档案包新增「决策人」:姓名/职位/部门、联系方式与状态徽标(VALID/RISKY/PROBABLE/BLOCKED/INVALID/UNVERIFIED 照实标注)、来源链接/证据时间/证据层级(索引片段/历史档案/公开页);发现/猜测/验证三个动作都要求显式 GDPR Art.6 依据,RISKY/推断邮箱必须二次确认 |
| 上线记录 | 引擎镜像 `08b1b30c`(含 #718 窄 scope、#720 discover 报价)已上线;role map 经 `engine-integration-apply.py --apply` 只给 `saas-admin` 增补 `contact-discovery:read`(`personal-data:read` 仍只授事件消费身份);gain-saas main `f24806b` 重建并重启。管理员 UAT(Trik Pumpen):公司详情 200、发现 201(1 位决策人)、猜测 200(RISKY 邮箱)、验证 200(RISKY/`mail_from_rejected`,lawful basis 留痕)。运维记录见 `/global/_archive/engine-integration-gain-saas-xin-20261102/` |
| 未覆盖/阻塞 | ① 周报 CSV 的「联系路径」列仍由引擎生成,引擎周报服务明确不读 `canonical_contact`/`contact_point`;升级需引擎侧改动(BFF 不做 CSV 重写,违反 SD7 只透传)。② 已观察缺陷:ftc-de.com `discover` 返回 500 `INTERNAL`(decision_maker 抽到 2 人但持久化失败,引擎 `HttpError` 日志无堆栈,待补未捕获异常日志并复现);缺 lawfulBasis 时引擎实测返回 400 `VALIDATION_ERROR` 而非文档写的 403;成员演示账号 `sales@demo.cn` 登录失效(文档待同步) |
| 验证 | server 全量 149 单测全过(本 PR 新增 6 条 BFF 与 1 条 shared 文案用例,含 Grant 接线、quote body 绑定、业务 403 映射、quote 拒绝码透出);web typecheck/build 通过(仅剩仓库既有的 vxe-pc-ui 声明告警);管理员 UAT 见上 |

## 前端信息补齐与联系人发现幂等(2026-11-03)

| 内容 | 说明 | 验证 |
| --- | --- | --- |
| 寻源任务页 | 阶段条新增「联系人发现」;技术详情新增联系人产出卡(公司/联系人/邮箱/电话/失败/租约跳过/预算截断/诊断、联系人预算花费与上限、邮箱推测计数)与「跳过与降级」卡(跳过的查询、按阶段租约跳过、模型抽取调用/失败、不可重放跳过、传输失败、行业分类规则兜底/模型跳过、分阶段预算截断) | CDP 以拦截响应注入完整 contacts/skips 统计:5 张卡(数据源/匹配结论/联系人发现/阶段产出/跳过与降级)全部渲染,无 console error |
| 线索档案包 | 评分维度改为引擎档案包的 snake_case(`demand_proof`/`data_quality`),补「综合分」;新增「公司画像」(贸易角色/置信度、自有制造、代理中国/外国品牌、代理品牌)、「登记号」(VAT/LEI/FDA/注册号)与「公司级联系方式」 | CDP 实拍 Biergangs Pumpen:画像、公司级联系方式、需求证明、资料质量、综合分 1 分均显示;无登记号数据时不渲染该块 |
| 寻源方案 | 展示引擎返回的 `estimatedCostCents`(「· 预计成本 $x.xx」),缺失时不占位 | CDP 拦截注入 1234 分,方案头显示「4 组搜索 · 预计约 450 家 · 预计成本 $12.34」 |
| i18n | zh-CN/en-US 新增 37 个键(寻源联系人/跳过、档案包画像/登记号、方案成本);全量 `baseCompile` 0 错误 | web typecheck 通过(仅仓库既有 vxe-pc-ui 声明告警)、production build 通过 |
| 联系人发现 attemptId(引擎) | 引擎 `DiscoverContactsDto` 接受可选 `attemptId`;request scope 仅在带 attemptId 时并入 `{attemptId}`(缺省保持旧哈希);quote 校验同步;OpenAPI/合同更新。前端每次点击生成 UUID(`crypto.randomUUID` 不可用时退回 `getRandomValues`) | 引擎工作区已改但**未构建/未提交**(仓库无 node_modules);已补 scope/quote 单测(含旧哈希不变、非法 UUID 拒绝) |
| BFF 兼容开关 | 新增 `ENGINE_DISCOVER_ATTEMPT_ID_ENABLED`(默认 false)。关闭时 BFF 从 quote 与转发体剥离 attemptId,旧引擎行为完全不变;引擎镜像升级后置 true | server typecheck 通过;161 单测全过;新增 quote 开关/剥离断言 |

> 上线顺序:引擎合并并构建含 attemptId 的镜像 → 滚动更新 → 在 gain-saas `.env` 设 `ENGINE_DISCOVER_ATTEMPT_ID_ENABLED=true` 并重启 server。此前重复点击「发现联系人」仍会命中旧引擎的 `EXECUTION_BUDGET_GRANT_REUSED`,前端提示保持不变。

</details>

## 下一步(按序)

1. **完成本候选的正常用户端到端验收**。在已确认的 `ff45fa4` + `a5ef77f6` 组合上，以正常管理员与受邀成员走通注册/邀请、启航清单、资料上传、买家画像、寻源与受理恢复、终态与人工接受、商机及可用触达，覆盖空结果、取消、部分成功与重试。
2. **按专项裁决关闭高风险边界**。依次核对并裁决：成员企业写权限与匿名查重披露、运营 `ops-pg` `ownerQuery` 白名单执行闸与只读分离、事件隔离观测/重放与 `SiteBuildCostSummaryUpdated` 形状对账、健康探针语义对齐、以及后端 main CI 失败原因。
3. **验证钱包、触达与 v3 切换前提**。在获得独立批准与真实运行配置读回后，分别验证钱包实际启用/预占/结算/退点、替身发送器下的零外发与回复停发、以及 Discovery v3 成组切换验收。

<details>
<summary>此前界面待办与风险（历史，按各自日期核对）</summary>

> 时效与承接说明（2026-11-28）：以下条目为历史记录原文，其中 **SD5 禁联名单读取与 BFF 权限**已在源码解决（后端 `GET /suppressions` 现役仅要求 `compliance:manage`，SaaS BFF 全部 5 条禁联路由均为 `admin`，`/settings/suppressions` 已在源码接入管理员管理页）；其余未结项（如运营域 E4 `ownerQuery` 写白名单执行闸）已在上方「待定决策与后续裁决项」登记。

4. **账户与安全**:CSRF 自定义头、JWKS 双钥轮换;工作空间创建/改名/切换/退出、改密、登录限流已实现(改密和停用会撤销其他设备会话)。
5. **运营域 E4 写白名单执行闸**:写语句白名单目前只有登记表、没有执行闸(`acq-admin` 已于 2026-10-30 退役,gain-saas 已由 systemd 托管)。
6. **引擎侧 Grant 前置校验/草稿幂等(已完成)**:引擎 #699(2026-10-30)改为「先验证 Grant → 业务前置校验 → 才消费」,草稿生成默认幂等;剩余「同一线索重新生成/新版本」受预算账户键固定限制(第二次 Grant 必然 409 `EXECUTION_BUDGET_GRANT_REUSED`),需引擎侧账户绑定语义另行设计。
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
| R4 平台授权信任 | 已于 2026-10-31 → 11-01 完成迁移:capability、预算 Grant 与撤销均由 gain-saas 签发,引擎 platform worker 的 env 指向 gain-saas(`18446`);4 个平台 schedule 仍 paused | 恢复 schedule 是产品负责人的单独决定;回退见工作区 RUNBOOK |
| 重新寻源 | PRD 设计为「改目标买家 → 重新生成方案 → 人工确认 → 新 run」;当前详情页没有"重新生成方案"入口,且引擎 `icp.query_plan` 预算账户按 ICP 一次性绑定,同一 ICP 第二次生成方案会 409 `EXECUTION_BUDGET_GRANT_REUSED`;同一 plan 执行后也不能重跑(EXECUTED/账户绑定) | 需引擎把 ICP 版本或请求幂等键纳入 query-plan request scope,再补 SaaS"重新生成方案"、方案版本快照与 run 历史;期间只能由运营重置账户做一次性验证 |
| 部署仍为手工窗口 | 发布 = 合并 main → CI 绿 → 部署窗口内构建并 `systemctl restart`,没有独立 CD 流水线 | 按[前端发布与回退](../engineering/frontend-release-rollback.md)执行;自动部署待发布线设计 |
| 顶栏重复渲染 | vben 布局在内容区顶部重复了一行搜索/图标(工作台与线索页同样出现,非 M3 引入) | 随 M3 布局收尾处理 |

</details>

## 运行手册速查

- 独立开发环境见 [README](../../README.md#开发)；本机发布与回退见[前端发布手册](../engineering/frontend-release-rollback.md)和工作区 RUNBOOK。
- 只读核对 SaaS Web、Worker、JWKS TLS、当前数据库连接及旧单元状态。获取 readiness、制品身份与具体任务的运行证据后再判断交付。

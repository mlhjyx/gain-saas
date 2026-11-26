# UI 重构功能盘点（改造前基线）

> 文档 ID：`DOC-EVIDENCE-UI-RESTYLE-INVENTORY-001`
> 基线：`ecebda2`（main）+ 分支 `feat/ui-restyle-agentsdr-sondara`
> 盘点日期：2026-11-22
> 盘点方法：逐页阅读 SFC 的 `<script setup>` 与 `<template>`（不含 style）、`api/gainos.ts`、`api/core/auth.ts`、路由模块、`packages/shared/src/glossary.ts`、`locales/langs/zh-CN/gainos.json`。所有 API 路径均为 `gainos.ts` 中的 BFF 相对路径；运行时前缀为 `VITE_GLOB_API_URL`（文档记录为 `/api`）。
> 使用方式：改造后逐项对零。任何“改造前”有、改造后没有，或文案/校验/请求发生变化，都必须在 PR 中说明；无说明即失败。
>
> **范围更新（2026-11-22，用户指示）**：登录后的系统内页面为改造对象；`/ops` 平台运营台、`/auth/login`、`/auth/register` 不因本次视觉改造而动。Phase 4 收敛为设置五页；§3 认证页仅作为功能基线保留。新增交互准则见 `AGENTS.md` §5.1：砍掉标语、提示文字和次要标签，靠布局表达；功能性标签/校验/错误/空状态/操作入口/API 不得删除。

---

## 0. 路由清单（硬基线）

### 0.1 产品路由（path/name/component 一个不动、一个不增、一个不减）

| # | path | name | component | meta 事实 |
|---|---|---|---|---|
| 1 | `/workspace` | `WorkspaceHome` | `#/views/workspace/index.vue` | `icon: lucide:layout-dashboard`、`order: 1`、`title: navTitle('workspace')`（工作台） |
| 2 | `/find-buyers` | `FindBuyers` | `#/views/find-buyers/index.vue` | `icon: lucide:radar`、`order: 3`、`title: navTitle('findBuyers')`（找买家） |
| 3 | `/runs/:runId` | `DiscoveryRun` | `#/views/runs/index.vue` | `hideInMenu: true`、`title: $t('gainos.runs.title')`（挖掘任务） |
| 4 | `/leads` | `Leads` | `#/views/leads/index.vue` | `icon: lucide:users`、`order: 5`、`title: navTitle('leads')`（买家线索） |
| 5 | `/leads/:leadId` | `LeadDetail` | `#/views/leads/detail.vue` | `hideInMenu: true`、`fullPathKey: false`、`title: $t('gainos.leads.packageTitle')`（线索档案包） |
| 6 | `/qgos` | `Qgos` | `#/views/qgos/index.vue` | `hideInMenu: true`、`title: $t('gainos.qgos.title')`（商机） |
| 7 | `/campaigns` | `Campaigns` | `#/views/campaigns/index.vue` | `hideInMenu: true`、`icon: lucide:target`、`title: $t('gainos.menu.campaigns')`（战役计划） |
| 8 | `/campaigns/:campaignId` | `CampaignDetail` | `#/views/campaigns/detail.vue` | `hideInMenu: true`、`title: $t('gainos.menu.campaigns')`（战役计划） |
| 9 | `/companies` | `Companies` | `#/views/companies/index.vue` | `icon: lucide:building-2`、`order: 2`、`title: navTitle('companies')`（公司档案） |
| 10 | `/growth` | `Growth` | `#/views/growth/index.vue` | `icon: lucide:handshake`、`order: 6`、`fullPathKey: false`、`title: navTitle('growth')`（商机与触达） |
| 11 | `/tasks` | `Tasks` | `#/views/tasks/index.vue` | `icon: lucide:list-checks`、`order: 4`、`title: $t('gainos.menu.tasks')`（挖掘任务） |
| 12 | `/tasks/:taskId` | `TaskDetail` | `#/views/tasks/detail.vue` | `hideInMenu: true`、`title: $t('gainos.tasks.detailTitle')`（任务详情） |
| 13 | `/notifications` | `Notifications` | `#/views/notifications/index.vue` | `hideInMenu: true`、`title: $t('gainos.notifications.pageTitle')`（通知） |
| 14 | `/settings` | `Settings` | 无（redirect `/settings/members`） | `icon: lucide:settings`、`order: 6`、`title: navTitle('settings')`（设置） |
| 15 | `/settings/members` | `SettingsMembers` | `#/views/settings/members.vue` | 无 `authority`；图标 `lucide:users-round`；标题 `gainos.menu.members` |
| 16 | `/settings/suppressions` | `SettingsSuppressions` | `#/views/settings/suppressions.vue` | `authority: ['admin']`；`lucide:ban`；`gainos.menu.suppressions` |
| 17 | `/settings/sources` | `SettingsSources` | `#/views/settings/sources.vue` | `authority: ['admin']`；`lucide:database`；`gainos.menu.sources` |
| 18 | `/settings/privacy` | `SettingsPrivacy` | `#/views/settings/privacy.vue` | `authority: ['admin']`；`lucide:shield-check`；`gainos.menu.privacy` |
| 19 | `/settings/audit` | `SettingsAudit` | `#/views/settings/audit.vue` | `authority: ['admin']`；`lucide:scroll-text`；`gainos.menu.audit` |

### 0.2 legacy 重定向（只跳转、不渲染页面；不进菜单/标签页）

| path | name | redirect |
|---|---|---|
| `/dashboard` | `LegacyDashboard` | `/workspace` |
| `/dashboard/analytics` | `LegacyDashboardAnalytics` | `/workspace` |
| `/demos` | `LegacyDemos` | `/workspace` |
| `/demos/antd` | `LegacyDemosAntd` | `/workspace` |
| `/profile` | `LegacyProfile` | `/settings/members` |
| `/about` | `LegacyAbout` | `/workspace` |
| `/settings/workspaces` | `LegacySettingsWorkspaces` | `/settings/members` |

### 0.3 core / auth / 非产品路由（不属于本次视觉改造清单，但必须保持可达且不改 path/name/component）

| path | name | component / 行为 |
|---|---|---|
| `/` | `Root` | `layouts/basic.vue`，redirect `preferences.app.defaultHomePath`（`/workspace`） |
| `/auth` | `Authentication` | `layouts/auth.vue`，redirect `LOGIN_PATH`（`/auth/login`） |
| `/auth/login` | `Login` | `#/views/_core/authentication/login.vue`（Phase 4 改造） |
| `/auth/register` | `Register` | `#/views/_core/authentication/register.vue`（Phase 4 改造） |
| `/auth/code-login` | `CodeLogin` | redirect `/auth/login`（无组件） |
| `/auth/qrcode-login` | `QrCodeLogin` | redirect `/auth/login`（无组件） |
| `/auth/forget-password` | `ForgetPassword` | **redirect `/auth/login`（无组件）**；`views/_core/authentication/forget-password.vue` 存在但不可达 |
| `/onboarding` | `OnboardingWizard` | `#/views/onboarding/index.vue`；`noBasicLayout`、`ignoreAccess`、`hideInMenu`、`hideInTab` |
| `/ops` | `OpsConsole` | `#/views/ops/index.vue`；`noBasicLayout`、`ignoreAccess`、`hideInMenu`；零术语扫描对其豁免 |
| `/:path(.*)*` | `FallbackNotFound` | `#/views/_core/fallback/not-found.vue` |

> 事实差异（改造前已存在，记录但不擅自修）：
> 1. `apps/web/e2e/dark-mode.spec.ts` 的 `PAGES` 含 `/outreach`，但路由表没有 `/outreach`；当前访问会落到 404。该 spec 只断言无横向溢出，因此基线不红。
> 2. `pnpm e2e:nav` 实际运行 `apps/web/e2e` 下 **22 个 spec**，不是 5 个；题目点名的 5 个 spec 都在其中。
> 3. `/auth/forget-password` 是 redirect，Phase 4 的“找回密码”没有可改造的独立页面（见 §2.17）。

---

## 1. 全局不变量与通用组件

### 1.1 硬约束

- `locales/langs/zh-CN/*.json` 与 `en-US/*.json`：**既有 key 与 value 一律不改**。新增驾驶舱文案如需 i18n，只能新增 key，且中英文同步；待 Phase 0 确认后执行。
- `apps/web/src/api/**` 一行不动；`apps/server/**`、`packages/engine-client/**` 不动。
- `store/**` 业务逻辑不动；`router/guard.ts`、`router/access.ts`、所有路由模块的 path/name/component 不动。
- 不新增 npm 依赖；只用 Ant Design Vue + 现有 Tailwind/Vben 配置。
- 不删除/不改名顶栏主题按钮（Vben 内置，`aria-label` 为 `dark` / `light`）。
- 深色主题与浅色主题同批交付；不允许只做浅色。
- 不写全局 CSS 去覆盖 `@vben/layouts` 内部类名；只通过 ConfigProvider token、`apps/web/src/styles`、页面 scoped 样式和 Tailwind 主题层实现。

### 1.2 通用页面组件（改造时保留其语义与三态顺序）

| 组件 | 文件 | 行为 |
|---|---|---|
| `PageContainer` | `components/gainos/page-container.vue` | 统一页宽/内边距；`compact` 用于 growth 内嵌页 |
| `PageHeader` | `components/gainos/page-header.vue` | `title` / `subtitle` / `#actions` |
| `AsyncSection` | `components/gainos/async-section.vue` | 三态顺序固定：`loading → error → empty → 内容`；错误态展示 `error.title` + `error.next` + `gainos.common.retry`；不展示 `why` |
| `ErrorNotice` | `components/error-notice.vue` | 展示 `title` / `why` / `next` / `code`；有 code 时折叠 `gainos.findBuyers.technicalDetails`（技术详情）；无重试按钮 |
| `SettingsShell` | `components/gainos/settings-shell.vue` | `title` / `subtitle` / `#actions` + 设置子导航；子导航 admin 项用 `accessStore.accessCodes.includes('ADMIN')` 过滤 |
| `AuthTools` | `components/AuthTools.vue` | 登录/注册页右上角语言与主题切换；主题按钮 `aria-label` 为 `切换到浅色` / `Switch to dark`（与顶栏 `dark/light` 不同） |

### 1.3 通用 API 口径

- `requestClient`：`responseReturn: 'data'`，成功时解包一层 `{ data }`；失败 reject，`failureText()` 优先取 BFF `error.userCopy.title/why/next`，兜底 `error.message` / `Error.message` / `请求失败，请稍后重试`。
- `pagedGet`：用 `baseRequestClient` 保留引擎 `{ data, page }` 信封。
- 全局错误拦截器会额外弹 `message.error`；登录/注册/接受邀请接口被排除。
- 权限码：`getAccessCodesApi()` 在 `session.workspace.role === 'admin'` 时返回 `['ADMIN']`，否则 `[]`。

---

## 2. 页面 × 功能

### 2.1 `/workspace` — 工作台（`WorkspaceHome`）

**权限**：`meta.authority` 无。页面内 `isAdmin = session.workspace.role === 'admin'`；仅影响 `sanctions_hold` 计数与最近线索是否包含合规待核。

**标题/文案键**

- H1：`gainos.workspace.title`（`{greeting}，今天让增长往前一步。`）
- `greeting`：`gainos.workspace.greetingNight`（夜深了）/ `greetingMorning`（早上好）/ `greetingAfternoon`（下午好）/ `greetingEvening`（晚上好）
- 副标题 `pipelineSummary`：`summaryLoading`（正在整理你的进展…）/ `summaryIcpPending`（目标客户画像「{name}」 · {count} 条线索待判断）/ `summaryIcpFollowing`（…{count} 条线索值得跟进）/ `summaryIcp`（当前目标客户画像：{name}）/ `summaryNoIcp`（公司档案已建立，下一步设定目标客户画像）/ `summaryEmpty`（先建立公司档案，GainOS 才能开始找买家）
- 角色：`gainos.workspace.roleAdmin`（管理员）/ `roleMember`（成员）

**表单**：无表单字段。

**按钮/操作**

| 文案（key + 中文） | 动作 | 条件 |
|---|---|---|
| `gainos.common.refresh` 刷新 / `refreshing` 刷新中… | `load()` | 无禁用 |
| `gainos.common.retry` 重试 | `load()` | 错误条/通知错误态 |
| `gainos.workspace.markAllRead` 全部已读 | `readAllNotifications()` + 本地置已读 | `unreadCount > 0`；`notificationsLoading` 时禁用 |
| 通知条目（整行） | `openNotification(item)`：先 `readNotification`，再按 `item.link` 跳转（http(s) 新窗口，否则 router.push） | 无 |
| `nextAction.action`（下一步 CTA） | `router.push(nextAction.to)` | `loading` 时禁用 |
| 6 个 KPI 卡片（整卡） | 跳转 `/companies`、`/find-buyers`、`/tasks`、`/leads?queue=needs_review`、`/leads?queue=recommended`、`/settings/members` | 无 |
| `gainos.workspace.viewAllLeads` 查看全部 | `/leads` | 无 |
| 最近线索行 | `openLead(lead)` → `/leads?queue={queue}` | 无 |

**数据块（非表格）**

- 五步主链路 `STEP_KEYS`：`stepProfile` 完善档案 / `stepIcp` 设定目标客户画像 / `stepPlan` 确认寻源方案 / `stepRun` 等待寻源 / `stepJudge` 判断线索；`aria-label` 用 `stepProgress`（第 {current} / {total} 步）。
- KPI 6 个：`kpiCompanies` 公司档案、`kpiBuyers` 目标客户画像、`kpiRun` 挖掘任务、`kpiPending` 待判断线索、`kpiFollowing` 值得跟进、`kpiTeam` 团队；各自 hint 键：`kpiCompaniesHint` / `kpiFacts` / `kpiFactsWithPending` / `kpiNoFacts` / `kpiBuyerHint` / `kpiNoBuyer` / `kpiRunHint` / `kpiRunDraftHint` / `kpiRunExecutedHint` / `kpiRunReadyHint` / `kpiRunEmptyHint` / `kpiNoRun` / `kpiPendingHint` / `kpiPendingSanctions` / `kpiFollowingHint` / `kpiFollowingAccepted` / `kpiTeamHint`。
- 通知面板：`notifications.default` 通知；`notificationsUnread` {count} 条未读；`notificationsEmpty` 暂时没有通知。新的寻源进展和线索会在这里提醒你。
- 最近线索：`recentLeads` 最近线索；`recentLeadsEmpty` 还没有线索。发起寻源后，值得跟进的候选企业会出现在这里；`leads.unknownCompany` 未命名公司；`leads.score` {score} 分。
- 通知类型映射：`notifications.runCompleted` / `runCompletedMessage` / `runPartial` / `runPartialMessage` / `runFailed` / `runFailedMessage` / `leadQualified` / `leadQualifiedMessage` / `claimApproved` / `claimApprovedMessage` / `claimRejected` / `claimRejectedMessage` / `default`。

**弹窗**：无。

**API**

| 方法 | HTTP | 路径 | 时机 |
|---|---|---|---|
| `session()` | GET | `/auth/session` | `load()` |
| `companies()` | GET | `/companies` | `load()` |
| `icps()` | GET | `/icps` | `load()` |
| `notifications()` | GET | `/notifications` | `load()` |
| `members()` | GET | `/members` | `load()` |
| `discoveryRunLinks(icpId)` | GET | `/runs?icpId={icpId}` | `load()`，每个 ACTIVE ICP |
| `queryPlans(icpId)` | GET | `/icps/{icpId}/query-plans` | 选定 active ICP 后 |
| `leadQueues(icpId)` | GET | `/icps/{icpId}/lead-queues` | 同上 |
| `leads({icpId, limit:200})` | GET | `/leads?icpId={id}&limit=200` | 同上 |
| `discoveryRun(runId)` | GET | `/discovery-runs/{runId}` | 有 latestRunLink 时 |
| `companyCompleteness(companyId)` | GET | `/companies/{companyId}/completeness` | 每个公司 |
| `readNotification(id)` | POST | `/notifications/{id}/read` | 点击未读通知 |
| `readAllNotifications()` | POST | `/notifications/read-all` | 全部已读 |

**Locales keys（本页直接引用）**

`gainos.common.loading/refresh/refreshing/retry`；`gainos.leads.score/unknownCompany`；`gainos.notifications.default/runCompleted/runCompletedMessage/runPartial/runPartialMessage/runFailed/runFailedMessage/leadQualified/leadQualifiedMessage/claimApproved/claimApprovedMessage/claimRejected/claimRejectedMessage`；`gainos.findBuyers.planStatus.DRAFT/READY/EXECUTED`；`gainos.workspace.*`（title、greetingNight/Morning/Afternoon/Evening、roleAdmin/roleMember、stepProfile/stepIcp/stepPlan/stepRun/stepJudge/stepProgress、summary* 6 个、next* 全部、overviewTitle、kpi* 全部、notificationsEmpty/notificationsUnread/markAllRead、recentLeads/recentLeadsEmpty/viewAllLeads）。

**空/错状态**

- 顶部 `role="alert"` 错误条：`failureText.title` + `next`；CTA `gainos.common.retry`。
- 通知加载中 `gainos.common.loading`；失败 `notificationsError` + 重试；空 `notificationsEmpty`。
- 最近线索空 `recentLeadsEmpty`（无 CTA，标题旁“查看全部”仍在）。

---

### 2.2 `/find-buyers` — 找买家（`FindBuyers`）

**权限**：无 `meta.authority`；页面无角色判断。操作只受数据状态/loading 限制。

**标题/文案键**：`gainos.findBuyers.stage`（第 2 步 · 设定目标客户画像）、`title`（找买家）、`subtitle`、`listTitle`（目标客户画像）、`listDesc`、`activeHint`（生效中：{name}）；步骤条复用 `gainos.workspace.step*` 与 `stepProgress`。

**表单/校验（全部为原生控件 + 内联校验，无 Form rules）**

| 位置 | 字段 | 控件/默认值 | 校验原文 / 错误文案 |
|---|---|---|---|
| 生成初稿弹窗 | 引用哪份公司档案 `findBuyers.company` | `<select v-model="selectedCompanyId">`；默认 `companiesWithoutIcp[0]?.id ?? ''` | `canCreateIcp = Boolean(selectedCompanyId) && !creating && !claimsChecking && approvedClaimCount !== null && approvedClaimCount > 0`；`createIcp()` 首行 `if (!canCreateIcp.value || !selectedCompanyId.value) return;`；`openCreate()` 若所有公司已有 ICP → `notice = allCompaniesHaveIcp` |
| 详情高级区·规则 | `ruleKind` 规则类型 | `<select>`；默认 `MUST_HAVE`；选项 `MUST_HAVE/NICE_TO_HAVE/EXCLUSION` → `ruleKind.*` | 无校验 |
| 同上 | `ruleField` 字段 | `<input>`；默认 `industry` | 无校验 |
| 同上 | `ruleOperator` 操作符 | `<select>`；默认 `eq`；9 个操作符 → `ruleOperator.*` | 无校验 |
| 同上 | `ruleValue` 取值 | `<input>`；默认 `''`；placeholder `ruleValueHint`（文本；数组/数字用 JSON） | `parseRuleValue`：`JSON.parse` 成功返回值，失败返回原字符串 |
| 同上 | `ruleWeight` 权重 | `<input type="number" min="0" step="0.5">`；默认 `1` | `Number(weight) \|\| 0` |
| 同上 | `ruleRationale` 依据 | `<input>`；默认 `''` | trim 后非空才提交 |
| 编辑弹窗 | `name` 名称 | `<input>`；默认 `''` | 无；保存 trim |
| 同上 | `targetMarkets` 目标市场 | `<input>`；默认 `''`；placeholder `marketsHint`（多个市场用逗号分隔） | 无；保存按逗号切分、trim、去空 |
| 同上 | `painPoints/triggerSignals/exclusions/valueProps` | 4 个 `<textarea rows=4>`；默认 `''` | 无；保存按换行切分、trim、去空 |
| 同上 | `companyAttributes` 目标公司属性 | `<textarea rows=5>`；默认 `'{}'` | `JSON.parse(attributesText \|\| '{}')`；若 `!parsed \|\| typeof parsed !== 'object' \|\| Array.isArray(parsed)` → `editError={title: attributesInvalid, next: attributesHint}`（公司属性不是合法 JSON 对象 / 按键值对填写公司属性；不确定的属性可以留空。） |
| 回测 | 回测样例（JSON） | `<textarea rows=8>`；预置两条样例 | `JSON.parse`；`if (!Array.isArray(samples) \|\| samples.length === 0) throw new Error('invalid samples')`；SyntaxError → `backtestInvalid` + `backtestHint`（需要包含 name、attributes、expected（match 或 exclude）字段的数组。） |

**按钮/操作**

| 文案（key + 中文） | 动作 | 条件 |
|---|---|---|
| `common.refresh` 刷新 / `refreshing` 刷新中… | `load()` | 无 |
| `findBuyers.newIcp` 设定目标客户画像 | `openCreate()` | `icps.length > 0` |
| `emptyCta` 设定目标客户画像 | `openCreate()` | 空态 |
| `view` 查看与调整 | `openDetail(icp)` | 无 |
| `activate` 激活目标客户画像 / `activating` 激活中… | `activateIcp` | ICP 状态为 DRAFT/HYPOTHESIS/VALIDATING |
| `edit` 编辑 | `openEdit()` | 无 |
| `addRule` 新增规则 / `editRule` 编辑 / `deleteRule` 删除 | 打开规则表单 / `window.confirm(deleteRuleConfirm)` + DELETE | 无 |
| `saveRule` 保存规则 | `createIcpRule` / `updateIcpRule` | `ruleBusy` 时禁用 |
| `runBacktest` 运行回测 / `common.loading` | `runBacktest` | `backtestBusy` 时禁用 |
| `createPlan` 生成寻源方案 | `createQueryPlan` | 无方案且 ICP 为 ACTIVE；非 ACTIVE 时禁用并提示 `planNeedsActive` |
| `confirmPlan` 确认方案 | `confirmQueryPlan` | `plan.status === 'DRAFT'` |
| `executePlan` 开始寻源 | `ensureTask` + `startAcquisitionTaskRun` + `recordDiscoveryRun` + 跳 `/runs/:runId` | `plan.status === 'READY'` |
| `viewRun` 查看挖掘任务 | 跳 `/runs/:runId` | 有 runRef |
| `generate` 生成初稿 / `generating` 生成中… | `createIcp` | `canCreateIcp` |
| `saveChanges` 保存修改 | `updateIcp` | `editing` 时禁用 |

**列表/详情节（非表格，无 dataIndex/分页/排序）**

- ICP 卡片：`icp.name`、公司名 · `v{version}`、状态徽章（glossary）、目标市场 chips、`{rules.length} 条资格规则 · {personas.length} 个买家画像`（硬编码中文）、`view`。
- 详情区块：`targetMarkets` / `companyAttributes` / `painPoints` / `triggerSignals` / `exclusions` / `valueProps` / `personas` / `goals` / `buyingCommittee` / `advanced`（规则与回测折叠）/ `suggestionsTitle` / `plansTitle` / `taskRunsTitle`。
- 方案卡：状态 `planStatus.*`、`planSearchCount`、`planEstimated`、`planEstimatedCost`、`planSources`、`planConditions`、`planPriority`、`planRaw`；空 `noPlans`。
- 最近运行：运行状态徽章 + `formatDateTime(startedAt)` + `viewRun`；空 `taskRunsEmpty`。

**弹窗**

| 类型 | 标题 | 字段 | 按钮 |
|---|---|---|---|
| 遮罩弹窗（create，窄） | `createTitle` 设定目标客户画像 | 公司选择；提示 `noCompanies` / `allCompaniesHaveIcp` / `checkingFacts` / `factsCheckFailed` / `noApprovedFacts` / `approvedFactsCount` / `createNote` | 取消 / 生成初稿（`generate`，disabled `!canCreateIcp`）/ × |
| 遮罩弹窗（详情） | `selected.name` | 见上 | 激活 / 编辑 / ×；点遮罩关闭 |
| 遮罩弹窗（edit，窄） | `editTitle` 编辑目标客户画像 | 见上 | 取消 / 保存修改（`saveChanges`）/ × |
| 浏览器确认框 | `deleteRuleConfirm` 删除这条规则？ | — | 确定/取消 |

**API**

| 方法 | HTTP | 路径 | 时机 |
|---|---|---|---|
| `icps()` | GET | `/icps` | load / 刷新 / create / activate / saveEdit / 规则变更后 |
| `companies()` | GET | `/companies` | load |
| `claims(companyId,'APPROVED')` | GET | `/companies/{companyId}/claims?status=APPROVED` | 选择公司 / 打开 create / 事实检查重试 |
| `icp(icpId)` | GET | `/icps/{icpId}` | openDetail / 规则或回测后 |
| `queryPlans(icpId)` | GET | `/icps/{icpId}/query-plans` | openDetail / createPlan / confirmPlan / executePlan / activate |
| `discoveryRunLinks(icpId)` | GET | `/runs?icpId={icpId}` | openDetail |
| `acquisitionTasks(icpId)` | GET | `/tasks?icpId={icpId}` | openDetail / ensureTask |
| `icpFeedback(icpId)` | GET | `/icps/{icpId}/feedback` | openDetail（失败静默） |
| `createIcp(companyId)` | POST | `/companies/{companyId}/icps` | 生成初稿 |
| `activateIcp(icpId)` | POST | `/icps/{icpId}/activate` | 激活 |
| `updateIcp(icpId,input)` | PATCH | `/icps/{icpId}` | 保存修改 |
| `createIcpRule(icpId,input)` | POST | `/icps/{icpId}/rules` | 保存新规则 |
| `updateIcpRule(ruleId,input)` | PATCH | `/icp-rules/{ruleId}` | 保存编辑规则 |
| `deleteIcpRule(ruleId)` | DELETE | `/icp-rules/{ruleId}` | 删除规则 |
| `runBacktest(icpId,samples)` | POST | `/icps/{icpId}/backtests` | 运行回测 |
| `createQueryPlan(icpId,attemptId)` | POST | `/icps/{icpId}/query-plans` | 生成方案（每次新 attemptId） |
| `confirmQueryPlan(planId)` | POST | `/query-plans/{planId}/confirm` | 确认方案 |
| `createAcquisitionTask({icpId,name})` | POST | `/tasks` | ensureTask（无任务时） |
| `startAcquisitionTaskRun(taskId,planId,attemptId)` | POST | `/tasks/{taskId}/runs` | 开始寻源 |
| `recordDiscoveryRun({runId,planId,icpId})` | POST | `/runs` | 执行成功拿到 runId 后（失败忽略） |

**Locales keys（本页直接引用）**

`gainos.common.cancel/loading/refresh/refreshing/retry`；`gainos.findBuyers.*`：stage、title、subtitle、listTitle、listDesc、activeHint、newIcp、emptyTitle、emptyDesc、emptyCta、view、unknownCompany、version、createTitle、createDesc、company、noCompanies、allCompaniesHaveIcp、checkingFacts、factsCheckFailed、noApprovedFacts、approvedFactsCount、createNote、generate、generating、created、technicalDetails、detailKicker、detailHint、activate、activating、activated、edit、editTitle、saveChanges、saved、targetMarkets、companyAttributes、painPoints、triggerSignals、exclusions、valueProps、personas、goals、buyingCommittee、advanced、ruleLint、rulesTitle、rulesDesc、addRule、noRules、editRule、deleteRule、deleteRuleConfirm、ruleDeleted、ruleSaved、ruleKind、ruleField、ruleOperator、ruleValue、ruleValueHint、ruleWeight、ruleRationale、saveRule、backtestTitle、backtestDesc、backtestSamples、backtestInvalid、backtestHint、runBacktest、suggestionsTitle、suggestionsDesc、plansTitle、plansDesc、createPlan、planNeedsActive、noPlans、planSearchCount、planEstimated、planEstimatedCost、planSources、planConditions、planPriority、planRaw、confirmPlan、executePlan、planCreated、planConfirmed、viewRun、runStarted、runLinkMissing、runStarting、taskRunsTitle、taskRunsDesc、taskRunsEmpty、marketsHint、name、attributesHint、attributesInvalid；动态 `planStatus.*`、`querySource.*`、`queryFilter.*`、`tradeSide.*`、`ruleKind.*`、`ruleOperator.*`；复用 `gainos.workspace.step*`。

**空/错状态**

- loadError：`failureText.title` + `next` + `common.retry`。
- ICP 空：`emptyTitle` / `emptyDesc` / `emptyCta`。
- 无公司：`noCompanies`；全部公司已有 ICP：`allCompaniesHaveIcp`；事实检查中/失败/无已通过事实：对应键。
- 详情 detailError 无重试按钮；规则空 `noRules`；方案空 `noPlans`；已执行但无本地 run：`runLinkMissing`；任务运行空 `taskRunsEmpty`。

---

### 2.3 `/runs/:runId` — 挖掘任务（`DiscoveryRun`）

**权限**：无 `meta.authority`；`hideInMenu`。页面无角色判断。停止仅 RUNNING；重试条件见下。

**标题/文案键**：`gainos.runs.title`（挖掘任务）、`subtitle`、`kicker`（第 3 步 · 寻源执行）、`back`（返回找买家）、`icp` / `plan` / `taskId`、`taskLabel`、`started` / `completed` / `duration`、`runStatusHint`、`autoRefresh`（运行中每 3 秒自动刷新）、`stopDeep` / `stopConfirm` / `stopRequested`、`retry` / `retryTitle` / `retryLastOutcomeLabel` / `retryLastOutcome` / `retryBudget` / `retryConfirm` / `retryRequested` / `retryUnavailable`。

**表单/输入**

| 控件 | 默认值 | 行为 |
|---|---|---|
| 自动刷新 checkbox | `auto` | `v-if run.status === 'RUNNING'`；`toggleAuto()` 调 `schedule()` |
| 重试弹窗 | 无输入 | `canRetry = Boolean(run) && (status === 'FAILED' \|\| 'PARTIAL' \|\| 'CANCELLED') && Boolean(run.taskRef?.taskId) && Boolean(run.planId)`；`confirmRetry()` 首行 `if (retrying \|\| !run) return;`；缺 taskId/planId → `retryUnavailable` |
| 停止深挖 | — | `window.confirm(stopConfirm)` 后 POST cancel |

**按钮**

| 文案 | 动作 | 条件 |
|---|---|---|
| `back` 返回找买家 | `/find-buyers` | 始终 |
| `autoRefresh` | 切换自动刷新 | RUNNING |
| `stopDeep` 停止深挖 / `common.loading` | `cancelDiscoveryRun` | RUNNING；`stopping` 禁用 |
| `retry` 重试 | 打开重试弹窗 | `canRetry` |
| `common.refresh` 刷新 | `load()` | 始终 |
| `quickToggleAll` 显示全部 / `quickToggleCollapse` 收起 | 切换快扫名单过滤 | 始终 |
| `traceLoadMore` 加载更多 | `loadMoreTrace()` | `traceHasMore`；`traceLoading` 禁用 |
| `goLeads` 去判断线索 | `/leads` | `runActions.canViewLeads` |
| `adjustIcp` 调整目标客户画像 | `/find-buyers` | PARTIAL/FAILED 区块 |
| `attemptOpen` 打开 | 跳转历史 run | 非当前 run 且有 runId |

**数据块/表格**

- 状态摘要卡：状态徽章（glossary `run`）、`started` / `taskLabel`（链接 TaskDetail）/ `duration` / `completed` / `runStatusHint`。
- 5 个摘要数字：`summaryCompanies` 找到企业、`summaryMatch` 匹配目标、`summaryPartialMatch` 部分匹配、`summaryExcluded` 已排除、`summaryDuration` 本轮耗时。
- 快扫名单表：列 `jobName` 公司（name/domain）、`jobStageColumn` 状态（`jobStage.*`）、`jobVerdictLabel` 判定（`jobVerdict.*`）；默认隐藏 `verdictQuick === 'mismatch'`；空 `jobsEmpty` / `quickFilterEmpty`。
- 深挖队列表：列 `jobName` / `jobStageColumn` / `jobVerdictLabel` / `jobError`（`jobErrorPipeline` / `jobErrorCancelled`）；空 `jobsEmpty`。
- 寻源过程：`traceTitle` / `traceSubtitle` / `traceLoading` / `traceEmpty` / `traceLoadError`；每条含 agent/step/attempt/headline/detail/rejected/evidence/tech 折叠；游标分页 `limit:50`。
- 用户五阶段：search / collect / match / enrich / output，文案 `userStage.*`；tone `stageState.*`。
- 技术阶段 9 卡：query / canonicalize / fit / websiteProfile / enrich / signals / contacts / watches / patentEnqueue；文案 `stage*` / `*Hint`。
- 技术产出：`sourcesTitle`（列 `source` / `sourceRaw` / `sourceGovernance` / `sourceCost` / `sourceError`）、`fitTitle`、`contactsTitle`、`outputsTitle`、`skipsTitle`、`detailsTitle`。
- 失败区块：`failedAtStage` / `failedUnknownStage` / `failureHint` / `failureStage` / `failureType` / `failureControl`。

**弹窗**

| 类型 | 标题 | 内容 | 按钮 |
|---|---|---|---|
| 自定义 modal | `retryTitle` 重试这次挖掘 | `retryLastOutcomeLabel` + 上次结果；`retryBudget`（会新申请预算、计入次数上限、上次线索保留）；`retryError` | 取消 / 确认重试（`retryConfirm`，busy 时 `common.loading`） |
| 浏览器确认框 | `stopConfirm` | 停止深挖后已完成结果保留、未完成下次重新排队 | 确定/取消 |

**API**

| 方法 | HTTP | 路径 | 时机 |
|---|---|---|---|
| `discoveryRun(runId)` | GET | `/discovery-runs/{runId}` | load / 刷新 / 3s 轮询 / 停止后 / 重试无 runId |
| `runEvents(runId, after, 200)` | GET | `/discovery-runs/{runId}/events?after={lastSeq}&limit=200` | load 内轮询 |
| `runJobs(runId, 200)` | GET | `/discovery-runs/{runId}/jobs?limit=200` | 首次 jobs 为空 / 事件更新 |
| `runTrace(runId,{limit:50,cursor?})` | GET | `/runs/{runId}/trace` | 首次 / 加载更多 / 事件更新 |
| `acquisitionTasks(icpId)` | GET | `/tasks?icpId={icpId}` | load 的 loadTaskAttempts / 对账重试 |
| `startAcquisitionTaskRun(taskId,planId,attemptId)` | POST | `/tasks/{taskId}/runs` | 确认重试 |
| `cancelDiscoveryRun(runId)` | POST | `/discovery-runs/{runId}/cancel` | 停止深挖 confirm 后 |

**Locales keys（本页直接引用）**

`gainos.common.cancel/loading/refresh`；`gainos.runs.*`：title、subtitle、kicker、back、icp、plan、taskId、taskLabel、started、completed、duration、runStatusHint、summaryCompanies、summaryMatch、summaryPartialMatch、summaryExcluded、summaryDuration、metaJudged、metaPrefiltered、metaDeep、metaFailureHigh、autoRefresh、stopDeep、stopConfirm、stopRequested、retry、retryTitle、retryLastOutcomeLabel、retryLastOutcome、retryBudget、retryConfirm、retryRequested、retryUnavailable、quickListTitle、quickSummary、quickToggleAll、quickToggleCollapse、quickFilterEmpty、jobsEmpty、jobName、jobStageColumn、jobVerdictLabel、jobError、jobErrorPipeline、jobErrorCancelled、deepQueueTitle、traceTitle、traceSubtitle、traceLoading、traceEmpty、traceLoadError、traceAttemptBadge、traceChosenSources、traceNoSource、traceReason、traceReasonUnknown、traceSkipped、traceRejected、traceJudged、traceVerdicts、traceEvidenceLink、traceTech、traceTechDecision、traceTechAgent、traceTechAttempt、traceTechReason、traceTechScore、traceTechCost、traceTechRejected、traceTechTraceId、traceLoadMore、traceAgentFallback、traceStepFallback、traceSourceOther、userProgress、pipeline、stageQuery、stageCanonical、stageFit、stageWebsite、stageEnrich、stageSignals、stageContacts、stageWatches、stagePatents、queryHint、canonicalHint、websiteHint、ofHint、contactsHint、techStages、techOutputs、techDetails、failureHint、failureStage、failureType、failureControl、failedAtStage、failedUnknownStage、partialTitle、partialDesc、failedTitle、failedDesc、goLeads、adjustIcp、attemptHistoryTitle、attemptColumn、attemptStatus、attemptNth、attemptRetriedFrom、attemptOpen、sourcesTitle、source、sourceRaw、sourceGovernance、sourceCost、sourceError、emptySources、fitTitle、unjudged、skippedForBudget、contactsTitle、contactsCompanies、contactsPeople、contactsEmails、contactsPhones、contactsFailed、leaseSkipped、contactsBudgetCut、contactsBudget、contactsBudgetExhausted、emailGuess、emailGuessValue、outputsTitle、skipsTitle、skippedQueries、skippedForLease、modelExtractions、modelExtractionsValue、unreplayable、transportFailed、taxonomy、taxonomyValue、budgetCutByStage、budgetCutValue、detailsTitle；动态 `userStage.*`、`stageState.*`、`jobStage.*`、`jobVerdict.*`、`traceStep.*`、`traceRejectReason.*`、`traceVerdictReason.*`、`traceAgent.*`、`traceSource.*`。

**空/错状态**

- 首次 loading `common.loading`；loadError → `failureText.title/next` + `back`（错误块内无重试，头部刷新仍可用）。
- 停止失败 `jobError`；停止成功 `stopRequested`；重试成功 `retryRequested`；重试不可用 `retryUnavailable`。
- 快扫/深挖空 `jobsEmpty`；快扫过滤空 `quickFilterEmpty`；过程 loading/error/empty 对应键；数据源空 `emptySources`。
- PARTIAL 横幅 `partialTitle/partialDesc`；FAILED 横幅 `failedTitle/failedDesc`；失败区块 `failureSummary` + `failureHint`。

### 2.4 `/leads` — 买家线索（`Leads`）

**权限**：无 `meta.authority`。`isAdmin = session.workspace?.role === 'admin'`；`sanctions_hold` 队列仅管理员可见，制裁 banner `:disabled="!isAdmin"`。

**标题/文案键**：`gainos.leads.stage`（第 5 步 · 判断线索）、`title`（买家线索）、`subtitle`、`icpFilter`（目标客户画像）、`qgoEntry`（商机）、`showingCount`（显示 {count} 条）。

**表单/校验**

| 位置 | 字段 | 控件/默认值 | 校验原文 / 错误文案 |
|---|---|---|---|
| 页头筛选 | 目标客户画像 | `<select v-model="activeIcpId">`；默认 ACTIVE 的第一份，否则第一份，否则 `''` | 无；`@change="load()"` |
| 裁决弹窗 | 原因 `reasonCode` | `<select>`；默认 `''`；accept 3 项 / reject 10 项 | reject 必填。`if (modal === 'reject' && !reasonCode) { actionError = { title: reasonRequired, next: rejectDesc }; return; }`（请选择一个原因 / 请选择一个原因；它会留痕并用于改进下一轮推荐。） |
| 裁决弹窗 | 补充说明 `reasonNote` | `<textarea rows=3>`；默认 `''` | 可选；无 maxlength |
| 提升商机 | 证据类型/URL/说明 | 行对象 `{type,url,support}`；首行 `customer_reply`，新增行 `other`；最多 10 行 | 无客户端校验；`type.trim()` 后提交 |
| 提升商机 | 下一步动作 | `<textarea rows=2 maxlength=500>`；默认 `''` | 提交按钮 `:disabled="promoteBusy \|\| !promoteNextStep.trim()"`；函数首行同条件 return |

**按钮/操作**

| 文案（key + 中文） | 动作 | 条件 |
|---|---|---|
| `qgoEntry` 商机 | `/qgos` | 无 |
| `common.refresh` 刷新 / `refreshing` 刷新中… | `load()` | 无 |
| `goFindBuyers` 去设定目标客户画像 | `/find-buyers` | 无 ICP 空态 |
| 队列卡片（glossary 标签：待我判断/值得跟进/已排除/禁联/合规待核） | 设置 `activeQueue`，`pageLimit=50`，`load()` | 无 |
| `sanctionsHoldCount` 另有 {count} 条线索命中制裁、等待管理员合规复核 + `queueSanctions` / `sanctionsAdminOnly` | `openSanctionsQueue()` | `!isAdmin` 禁用 |
| `common.retry` 重试 | `load()` | 错误态 |
| `emptyCta` 去设定目标客户画像 | `/find-buyers` | 空态 |
| `viewPackage` 查看档案包 | `/leads/:leadId` | 无 |
| `accept` 值得跟进 / `reject` 暂不跟进 | 打开裁决弹窗 | `canAct(lead)`：`!['rejected','suppressed','sanctions_hold'].includes(queue) && !['QUALIFIED','REJECTED','SUPPRESSED'].includes(status)` |
| `promoteQgo` 提升为商机 | 打开提升弹窗 | `!canAct(lead) && lead.status === 'QUALIFIED'` |
| `loadMore` 加载更多 | `pageLimit += 50; load()` | `hasMoreLeads` |
| `common.cancel` 取消 | 关闭弹窗 | 无 |
| `confirmAccept` 确认跟进 / `confirmReject` 确认排除 / `submitting` 提交中… | `submitDecision()` | `submitting` 禁用 |
| `addEvidence` 再加一条证据 | `addEvidenceRow()` | 长度 < 10 才追加 |
| × 移除证据行 | `removeEvidenceRow(i)` | `promoteEvidence.length <= 1` 禁用 |
| `promoteSubmit` 提升为商机 / `submitting` | `submitPromote()` | `promoteBusy \|\| !promoteNextStep.trim()` 禁用 |

**列表字段（卡片，非表格）**

公司名链接（`leads.unknownCompany` 兜底）、国家 · 行业、`score` {score} 分 / `notScored`、匹配理由前 2 条（`fitLabel` 兜底）、队列徽标（glossary `leadQueue`）、依据 `basis.*`（fit_gate_preset / score / human_accept / human_reject）、员工数（硬编码 ` 人`）、操作按钮。队列描述键：`queueReviewDesc` / `queueQualifiedDesc` / `queueRejectedDesc` / `queueSuppressedDesc` / `queueSanctionsDesc`。

**弹窗**

| 类型 | 标题 | 字段 | 按钮 |
|---|---|---|---|
| 裁决弹窗 | `acceptTitle` 标记为值得跟进 / `rejectTitle` 标记为暂不跟进 | 原因（reject 必填）、补充说明；错误块 `actionError` | 取消 / `confirmAccept` 或 `confirmReject`；×；点遮罩关闭；Escape 关闭 |
| 提升商机弹窗 | `promoteTitle` 提升为商机（QGO） | 证据区（至少一条，实际只强制下一步动作）、`addEvidence`、`promoteNextStep` | 取消 / `promoteSubmit`；×；点遮罩关闭 |
| 承诺 | `gainos.leads.promoteSubmit` 后跳 `/qgos` | — | — |

**API**

| 方法 | HTTP | 路径 | 时机 |
|---|---|---|---|
| `session()` | GET | `/auth/session` | onMounted（判断 admin） |
| `icps()` | GET | `/icps` | loadIcps |
| `leads({icpId,queue,limit})` | GET | `/leads` | onMounted / ICP / 队列 / 刷新 / 加载更多 / 裁决后 |
| `leadQueues(icpId)` | GET | `/icps/{icpId}/lead-queues` | 每次 leads 成功后 |
| `acceptLead(leadId,input,key)` | POST | `/leads/{leadId}/accept` | 确认跟进；带 `Idempotency-Key` |
| `rejectLead(leadId,input,key)` | POST | `/leads/{leadId}/reject` | 确认排除；带 `Idempotency-Key` |
| `promoteQgo({leadRef,evidence,nextStep})` | POST | `/qgos` | 提升商机 |

**Locales keys（本页直接引用）**

`gainos.common.cancel/loading/refresh/refreshing/retry`；`gainos.leads.*`：accept、acceptDesc、acceptedNotice、acceptTitle、addEvidence、basis.preset/score/accept/reject、confirmAccept、confirmReject、emptyCta、emptyDesc、emptyTitle、evidenceType.customer_reply/purchase_page/tender_hit/customs_signal/other、fit.unknown/match/weak/mismatch、goFindBuyers、icpFilter、loadMore、noIcpDesc、noIcpTitle、notScored、promoteDone、promoteEvidence、promoteEvidenceType、promoteNextStep、promoteNextStepHint、promoteQgo、promoteSubmit、promoteSupportHint、promoteTitle、promoteUrlHint、qgoEntry、queueQualifiedDesc、queueRejectedDesc、queueReviewDesc、queueSanctions、queueSanctionsDesc、queueSuppressedDesc、reasonCode、reasonNote、reasonOptional、reasonPlaceholder、reasonRequired、reasonSelect、reject、rejectDesc、rejectedNotice、rejectTitle、sanctionsAdminOnly、sanctionsHoldCount、score、showingCount、stage、submitting、subtitle、title、unknownCompany、viewPackage、reason.NOT_TARGET_ROLE/WRONG_PRODUCT/TOO_SMALL/TOO_LARGE/ALREADY_KNOWN/NO_IMPORT_SIGNAL/WRONG_COUNTRY/BAD_CONTACT_PATH/DUPLICATE/OTHER/GOOD_FIT/WILL_FOLLOW_UP。

**空/错状态**：无 ICP → `noIcpTitle/noIcpDesc/goFindBuyers`；loading → 3 个 skeleton；loadError → `loadError.title/next` + retry；无线索 → `emptyTitle/emptyDesc/emptyCta`；成功 notice `acceptedNotice` / `rejectedNotice` / `promoteDone`。

---

### 2.5 `/leads/:leadId` — 线索档案包（`LeadDetail`）

**权限**：无 `meta.authority`；`isAdmin = accessStore.accessCodes.includes('ADMIN')`。`people` tab 仅管理员且 `canonical_company_id` 存在时渲染 `DecisionMakerCard`；否则 `peopleAdminOnly`。制裁复核按钮仅管理员且 `sanctionBlocked`。

**标题/文案键**：路由 `gainos.leads.packageTitle`（线索档案包）；`PageHeader` 标题为公司名或 `unknownCompany`；副标题为 `country · domain`；tabs aria `detailTabs`；状态 `status.*`。

**Tab（query `?tab=package|people|draft|outcomes`）**

| tab | 标签键 | 内容 |
|---|---|---|
| package | `tab.package` 档案 | `fitTitle` 匹配判断（`fit.verdict` + reasons）、`scoresTitle` 评分维度（`dim.fit/role/intent/demand_proof/reachability/data_quality/engagement/total`）、`profileTitle` 公司画像（`profileTradeRole/profileConfidence/profileCarriedBrands/profileOwnManufacturing/profileChineseBrand/profileForeignBrand/address/identifierRegister/identifierVat/identifierLei/identifierFda/profileEmpty`）、`contactTitle` 联系路径（`noContactPath`）、`evidenceTitle` 证据来源（`evidenceEmpty`）、`signalsTitle` 采购信号（`noSignals`）、`sanctionsTitle` 合规核验（`sanction.*`、`validUntil`） |
| people | `tab.people` 决策人 | `DecisionMakerCard`（见 §2.5.1）或 `peopleAdminOnly` |
| draft | `tab.draft` 触达草稿 | `outreachDraft` 生成接触草稿、`outreachDraftDesc`、`copy` / `copied`、`outreachNeedsQualified`、`outreachEmpty` |
| outcomes | `tab.outcomes` 结果 | `outcomesTitle` / `outcomesDesc` / `outcomesQgos` / `outcomesOutreach` |

**表单/校验**

| 位置 | 字段 | 控件/默认值 | 校验 |
|---|---|---|---|
| 裁决弹窗 | 原因 | `<select>`；默认 `''` | reject 必填：`if (decision === 'reject' && !reasonCode) return;`；按钮 `:disabled="submitting \|\| (decision === 'reject' && !reasonCode)"`（不显示错误文案） |
| 裁决弹窗 | 补充说明 | `<textarea rows=2 maxlength=500>`；默认 `''` | 可选 |
| 提升商机 | 证据类型/URL/说明 | 同列表页；最多 10 行 | 无客户端校验 |
| 提升商机 | 下一步动作 | `<textarea rows=2 maxlength=500>` | `:disabled="promoteBusy \|\| !promoteNextStep.trim()"` |
| 决策人弹窗 | 知晓确认 | checkbox；默认 `false` | 仅 RISKY 目标显示；`if (riskyTarget && !form.acknowledged) return false;` |

**按钮**

`backToList` 返回买家线索；`reject` 暂不跟进 / `accept` 值得跟进（仅 status DISCOVERED/REVIEW）；`promoteQgo` 提升为商机（QUALIFIED）；`goOutreach` 去触达批次（QUALIFIED）；4 个 tab；`outreachDraft` 生成接触草稿（QUALIFIED，`draftLoading` 禁用）；`copy` / `copied`；`outcomesQgos` / `outcomesOutreach`；`sanctionsClear` 误报，恢复队列 / `sanctionsConfirm` 确认命中（管理员 + sanctionBlocked，`sanctionsBusy` 禁用）；裁决弹窗取消/确认；提升弹窗取消/提交；证据行增加/移除。

**内容分区**：见上表；评分维度无数据 `notScored`；画像空 `profileEmpty`；联系路径空 `noContactPath`；证据空 `evidenceEmpty`；信号空 `noSignals`；制裁未筛查 `sanction.not_screened`。

**弹窗**：裁决弹窗（`acceptTitle`/`rejectTitle`，字段见上）、提升商机弹窗（`promoteTitle`）、`DecisionMakerCard` 弹窗（discover/guess/verify）。

**API**

| 方法 | HTTP | 路径 | 时机 |
|---|---|---|---|
| `leadPackage(leadId)` | GET | `/leads/{leadId}/package` | onMounted；成功后 loadDraft |
| `outreachDrafts(leadId)` | GET | `/leads/{leadId}/outreach-drafts` | loadDraft / 切 draft tab（失败静默 null） |
| `outreachDraft(leadId)` | POST | `/leads/{leadId}/outreach-drafts` | 生成草稿 |
| `acceptLead` / `rejectLead` | POST | `/leads/{leadId}/accept` 或 `/reject` | 裁决（带 Idempotency-Key） |
| `promoteQgo` | POST | `/qgos` | 提升商机 |
| `sanctionsReview(leadId,decision)` | POST | `/leads/{leadId}/sanctions-review` | 管理员制裁复核 |
| `canonicalCompany` / `complianceInfo` / `discoverContacts` / `guessEmails` / `verifyContactPoint` | 见 §2.5.1 | — | DecisionMakerCard |

**Locales keys（本页直接引用）**

`gainos.common.cancel/loading/retry`；`gainos.leads.*`：accept、acceptDesc、acceptedNotice、acceptTitle、addEvidence、address、backToList、confirmAccept、confirmReject、contactTitle、copied、copy、detailTabs、evidenceEmpty、evidenceTitle、evidenceType.*、fitTitle、fit.*、goOutreach、identifierFda/Lei/Register/Vat、noContactPath、noSignals、notScored、outcomesDesc、outcomesOutreach、outcomesQgos、outcomesTitle、outreachDraft、outreachDraftDesc、outreachEmpty、outreachNeedsQualified、peopleAdminOnly、profileCarriedBrands、profileChineseBrand、profileConfidence、profileEmpty、profileForeignBrand、profileOwnManufacturing、profileTitle、profileTradeRole、promoteEvidence、promoteEvidenceType、promoteNextStep、promoteNextStepHint、promoteQgo、promoteSubmit、promoteSupportHint、promoteTitle、promoteUrlHint、reasonCode、reasonNote、reasonOptional、reasonSelect、reject、rejectDesc、rejectedNotice、rejectTitle、sanction.*、sanctionsClear、sanctionsConfirm、sanctionsTitle、scoresTitle、signalsTitle、status.*、submitting、unknownCompany、validUntil、yes、dim.*、reason.*、tab.*。`gainos.contacts.*` 见 §2.5.1。

**空/错状态**：loading `common.loading`；error `AsyncSection` title/next + retry；画像/联系/证据/信号/制裁空态见上；草稿未达标/为空；制裁错误仅 title；notice accepted/rejected 无自动清除。

#### 2.5.1 `DecisionMakerCard`（people tab 子组件）

- 标题 `gainos.contacts.title`（决策人）/ `subtitle`；按钮 `guess` 猜测邮箱（有联系人时）、`discover` 发现联系人、`emptyCta` 发现联系人、`verify` 验证邮箱（email 触点）、`common.refresh` 刷新、`closeDialog` / `common.cancel` / `submit`（`submitting`）。
- 弹窗：`discoverTitle` / `guessTitle` / `verifyTitle`；描述 `discoverDesc` / `guessDesc` / `verifyDesc`；RISKY 时 `riskyWarning` + `acknowledge` checkbox；合法性依据只读 `lawfulBasis` + `platformBasis`（+ ref）。
- 联系人字段：头像、姓名、`roleLine`（`roleUnknown`）、`seniority.*`、联系方式（`type.email/phone/linkedin`）、状态 `status.VALID/RISKY/PROBABLE/BLOCKED/INVALID/UNVERIFIED`、来源 `layer.*`（`sourceUnknown`）、无联系方式 `noPoints`、缺邮箱 `missingEmail`。
- API：`canonicalCompany` GET `/canonical-companies/{companyId}`；`complianceInfo` GET `/settings/compliance`；`discoverContacts` POST `/canonical-companies/{companyId}/discover-contacts`；`guessEmails` POST `/canonical-companies/{companyId}/guess-emails`；`verifyContactPoint` POST `/contact-points/{pointId}/verify`。
- 空/错：空 `emptyTitle/emptyDesc/emptyCta`；加载错误 `loadError.title/next`（含“授权对接”时加 `scopeHint`）+ refresh；缺邮箱 `missingEmail`。

---

### 2.6 `/qgos` — 商机（`Qgos`）

**权限**：无 `meta.authority`；页面无角色判断。支持 `embedded` prop（growth tab 内不渲染页头）。

**标题/文案键**：`gainos.qgos.title`（商机）、`subtitle`、`all`（全部）、`state.OPEN/CONVERTED/DROPPED`（待裁决/已接受/已拒绝）、`emptyTitle/emptyDesc/emptyCta`、`loadMore`、`nextStep`、`score`（匹配度 {score}）、`evidenceCount`（{count} 条证据）。

**表单/校验（抽屉内）**

| 字段 | 控件/默认值 | 校验 |
|---|---|---|
| 拒绝理由 `declineReason` | `<Input maxlength=1000>`；默认 `''`；placeholder `declineReasonHint` | 两次点击确认：第一次 `declineArmed = true`；第二次提交。按钮 `:disabled="actionBusy \|\| (declineArmed && !declineReason.trim())"` |
| 结果 `outcomeValue` | `<Select>`；默认 `REPLIED`；7 个枚举 | 无 |
| 发生时间 | `<Input type="datetime-local">`；默认 `''` | 可选；提交 `new Date(value).toISOString()` |
| 备注 | `<Input maxlength=2000>`；默认 `''`；placeholder `outcomeNoteHint` | 可选；trim 后非空才提交 |

**按钮**：`goCampaigns` 去战役计划（非 embedded）、`backToLeads` 返回线索（非 embedded）、`common.refresh` 刷新 / `refreshing`、状态 Tabs、`loadMore` 加载更多、卡片点击打开 Drawer、`accept` 接受商机（OPEN，busy 禁用）、`decline` 拒绝 / `declineConfirm` 确认拒绝（OPEN）、`outcomeSubmit` 登记结果（`sao.state === 'ACCEPTED'`）。

**卡片字段**：`title`、状态徽章 `state.*`、`nextStep` + 值、`score`（`Math.round(score*100)`）、`evidenceCount`、`formatDateTime(createdAt)`。筛选仅状态 Tabs；分页 `limit=100` 递增。

**抽屉**：标题 `selected.title`，宽 560，right；区块 `nextStep` / `evidenceTitle`（类型/URL/support/retrievedAt）、`saoTitle`（`saoPending` / `saoAccepted` / `saoDeclined` / `declineReason`）、`decideTitle`（OPEN 时）、`outcomeTitle`（SAO ACCEPTED 时）；操作错误 `ErrorNotice`。

**API**

| 方法 | HTTP | 路径 | 时机 |
|---|---|---|---|
| `qgos({limit,state?})` | GET | `/qgos` | onMounted / tab / 刷新 / 加载更多 / refreshDetail |
| `qgo(id)` | GET | `/qgos/{id}` | 卡片点击 / refreshDetail |
| `acceptQgo(id)` | POST | `/qgos/{id}/accept` | 接受商机 |
| `declineQgo(id,reason)` | POST | `/qgos/{id}/decline` | 确认拒绝 |
| `addQgoOutcome(saoId,input)` | POST | `/saos/{saoId}/outcomes` | 登记结果 |

**Locales keys**：`gainos.common.loading/refresh/refreshing`；`gainos.qgos.*`：title、subtitle、goCampaigns、backToLeads、all、state.OPEN/CONVERTED/DROPPED、emptyTitle、emptyDesc、emptyCta、nextStep、score、evidenceCount、loadMore、evidenceTitle、saoTitle、saoPending、saoAccepted、saoDeclined、declineReason、decideTitle、declineReasonHint、accept、decline、declineConfirm、outcomeTitle、occurredAt、outcomeNoteHint、outcomeSubmit、outcomeSaved、acceptedNotice、declinedNotice、outcome.*；复用 `gainos.leads.evidenceType.*`、`gainos.findBuyers.technicalDetails`。

**空/错**：loading；loadError `ErrorNotice`（无重试，头部刷新）；空 `emptyTitle/emptyDesc/emptyCta`；抽屉 loading/error；SAO 未裁决 `saoPending`；证据/结果为空无专门文案；操作错误 `ErrorNotice`；成功 notice。

---

### 2.7 `/campaigns` — 战役计划（`Campaigns`）

**权限**：无 `meta.authority`；页面无角色判断。`embedded` 时隐藏页头，仅保留“新建计划”。

**标题/文案键**：`gainos.campaigns.title`（战役计划）、`subtitle`、`newCampaign`（新建计划）、`shadowBanner`、`colName/colStatus/colPlan/colUpdated`、`empty`、`create`、`nameLabel`（计划名称）、`objectiveLabel`（目标（一句话说明想达成什么））、`revision`（第 {no} 版）、`noRevision`（尚无计划草稿）、`status*`、`campaign*`、`ctaDraft/ctaActive/ctaView`。

**表单/校验（创建弹窗）**

| 字段 | 控件/默认值 | 校验 |
|---|---|---|
| `name` | `<Input maxlength=200>`；默认 `''` | `if (!name.trim()) { createError = $t('gainos.campaigns.nameLabel'); return; }`（复用字段 label 作为错误文案） |
| `objective` | `<TextArea rows=3 maxlength=500>`；默认 `''` | 可选；trim 后非空才提交 |

**表格（AntDV Table，无分页/筛选/排序）**

| 列 key | dataIndex | 标题键 | 内容 |
|---|---|---|---|
| name | name | `colName` 名称 | 名称加粗；有 objective 时追加一行 |
| status | status | `colStatus` 状态 | 徽章 + `campaign*` |
| plan | plan | `colPlan` 最新草稿 | `第 N 版 · 状态` 或 `noRevision` |
| updatedAt | updatedAt | `colUpdated` 更新时间 | `formatDateTime` |
| actions | actions | — | `ctaDraft` / `ctaActive` / `ctaView` |

**弹窗**：创建计划 Modal（宽 480；字段 name/objective；OK `create`，`confirm-loading`；Cancel 默认；错误 `Alert`）。点击行直接进详情。

**API**：`campaigns()` GET `/campaigns`（onMounted）；`createCampaign({name,objective?})` POST `/campaigns`（创建后跳详情）。

**Locales keys**：`gainos.menu.campaigns`、`gainos.campaigns.*`：title、subtitle、newCampaign、shadowBanner、colName、colStatus、colPlan、colUpdated、empty、create、nameLabel、objectiveLabel、revision、noRevision、statusDRAFT/SUBMITTED/APPROVED/DECLINED/EXPIRED/SUPERSEDED、campaignDRAFT/ACTIVE/PAUSED/ARCHIVED、ctaDraft、ctaActive、ctaView；`gainos.common.loading/retry`。

**空/错**：loading；error `AsyncSection` title/next + retry；空 `empty` + `newCampaign`；创建失败 Alert。

---

### 2.8 `/campaigns/:campaignId` — 战役详情（`CampaignDetail`）

**权限**：无 `meta.authority`；页面无角色判断（后端起草/提交/审批为 AdminGuard）。

**标题/文案键**：`gainos.menu.campaigns`（路由）、页头 `detail.name`（加载前回落菜单标题）、副标题 `detail.objective`；`gainos.campaigns.*`：goOutreach、shadowBanner、draftButton/drafting/draftFailed/draftRetryHint、submitted、approvalTitle、approvalExpires、approve/decline、approveDone/declineDone、planSummary、summaryGoal/summaryMetric/summaryAudience/summarySizeCap/summaryBudget/summaryMotion、motionDiscovery、sizeCapUnit、noBudget、submit、approvalExpired、why/whyBasis/whyTechnical/whyTechnicalHint、revisions、revision、planVersion、authorization、authIssued、traceTitle、traceStep.*、status*、noRevision、declineReason、declineReasonRequired、approveConfirm。

**表单/校验**

| 位置 | 字段 | 控件/默认值 | 校验 |
|---|---|---|---|
| 起草弹窗 | 受众 ICP | `<Select allow-clear>`；默认 `''` | 无；非空才提交 `icpId` |
| 起草弹窗 | 每个画像最多 | `<InputNumber min=1 max=1000>`；默认 `undefined` | 数字 > 0 才提交 `audienceSizeCap: Math.trunc(...)` |
| 起草弹窗 | 预算 USD | `<InputNumber min=0 step=0.01>`；默认 `undefined` | 数字 > 0 才提交 `budgetCapMicros: Math.round(usd*1_000_000)` |
| 拒绝弹窗 | 拒绝理由 | `<TextArea maxlength=500 rows=3>`；默认 `''` | `if (!declineReason.trim()) { declineError = $t('gainos.campaigns.declineReasonRequired'); return; }`（请填写拒绝理由，便于后续改进计划。） |

**按钮**：`goOutreach` 去触达批次（实际跳 `/campaigns`）；`draftButton` 让系统起草计划 / `drafting` 正在起草…（打开起草弹窗，busy 禁用）；`submit` 提交审批（latest.state DRAFT）；`approve` 批准 / `decline` 拒绝（有 pendingApproval）；`common.cancel` 取消；`common.retry` 重试。

**内容卡**：计划摘要 `summaryGoal/summaryMetric/summaryAudience/summarySizeCap/summaryBudget/summaryMotion`；为什么卡 `why` / `whyBasis` / `whyTechnical` / `whyTechnicalHint`；执行授权卡 `authorization` / `authIssued`；计划版本时间线 `revisions` / `revision` / 状态徽章 / `decisionReason`；决策记录 `traceTitle` / `traceStep.*` / `actorType`。无表格/筛选/排序/分页。

**弹窗**：起草计划（标题 `draftButton`，字段见上，OK `draftButton`，Cancel `common.cancel`，宽 480）；批准（标题 `approve`，展示 `conclusion` + `approveConfirm`）；拒绝（标题 `decline`，字段 reason，OK `decline` danger）。

**API**：`campaign(campaignId)` GET `/campaigns/{campaignId}`（onMounted，与 icps 并行）；`icps()` GET `/icps`；`createCampaignPlanDraft(campaignId,input)` POST `/campaigns/{campaignId}/plan-drafts`；`campaignPlanDraft(campaignId,jobId)` GET `/campaigns/{campaignId}/plan-drafts/{jobId}`（3s 轮询）；`submitCampaignRevision(campaignId,revisionId)` POST `/campaigns/{campaignId}/revisions/{revisionId}/submit`；`decideCampaignApproval(campaignId,approvalId,{decision,reason?})` POST `/campaigns/{campaignId}/approvals/{approvalId}/decide`。

**空/错**：loading；error `AsyncSection` title/next + retry；无版本 `noRevision`（无 CTA）；成功 notice Alert；失败 `actionError.title`（有 code 折叠 `whyTechnical`）；起草失败 `draftFailed · draftRetryHint`；轮询异常静默。

---

### 2.9 `/companies` — 公司档案（`Companies`）

**权限**：无 `meta.authority`。`isAdmin = session.workspace.role === 'admin'`。管理员专属：冲突“保留这条”、事实手动条（补充/生成草稿）、事实勾选/全选/批量通过/不采用、撤销已通过事实。非管理员可读“查看档案”（REVIEW/ACTIVE）、确认档案、补全/编辑/删除（DRAFT）、资料库。

**标题/文案键**：`gainos.companies.title`（公司档案）、`subtitle`、`cta`（建立档案）、`searchPlaceholder`、`filterAll`、`statusDraft/Enriching/Review/Active/Failed`、`showing`（显示 {shown} / {total} 家）、`emptyTitle/emptyDesc/emptyCta`、`noMatch`。

**表单/校验**

| 位置 | 字段 | 控件/默认值 | 校验原文 / 错误文案 |
|---|---|---|---|
| 列表筛选 | 搜索 | `<input type="search">`；默认 `''`；placeholder `searchPlaceholder` | 客户端匹配 name/domain/website/industry |
| 列表筛选 | 状态 | `<select>`；默认 `ALL`；选项 ALL/DRAFT/ENRICHING/REVIEW/ACTIVE/FAILED | 客户端过滤；FAILED = `status === 'DRAFT' && understandingFailedAt` |
| 建档向导 | 公司官网 | `<input type="url">`；默认 `''`；placeholder `websitePlaceholder` | 可选；非空必须匹配 `/^https?:\/\/.+/i`，否则 `errWebsiteInvalid`（官网需以 http:// 或 https:// 开头） |
| 建档向导 | 公司名称 | `<input type="text">`；默认 `''`；placeholder `namePlaceholder` | 可选；与官网至少填一个，否则 `errNameOrWebsite`（请至少填写公司名称或官网） |
| 编辑 | 名称 | `<input maxlength=200>`；默认 `company.name ?? ''` | 可选；trim 后非空才提交 |
| 编辑 | 官网 | `<input type="url">`；默认 `company.website ?? ''` | 非空必须匹配同上；否则 `errWebsiteInvalid` |
| 编辑 | 所属行业 | `<input maxlength=200>`；默认 `company.industry ?? ''` | 可选 |
| 编辑 | 业务邮箱 | `<input type="email" maxlength=320>`；默认 `company.businessEmail ?? ''` | 可选；表单 novalidate，无额外格式校验 |
| 编辑 | 目标市场 | `<input>`；默认 `(targetMarkets ?? []).join(', ')` | `parseMarkets`：按 `/[,，\s]+/u` 分割、trim、大写、去空；>30 项或任一不匹配 `/^[A-Z]{2}$/u` → `targetMarketsInvalid`（目标市场需为两位大写国家码，用逗号分隔） |
| 资料库 | 上传文件 | `<input type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.md">` | `docMime(file)` 按扩展名映射；取不到时要求 `file.type` 命中已知 MIME；否则 `uploadFailed`（reason `uploadFormats`） |
| 资料库 | 资料检索 | `<input type="search" minlength=2 maxlength=200>`；默认 `''` | `q.trim().length < 2` 直接 return |
| 事实 | 事实搜索 | `<input type="search">`；默认 `''` | 客户端匹配 statement/type/factKey |
| 事实 | 手动补充 | `<textarea rows=3 maxlength=2000>`；默认 `''` | 必填：`if (!companyId \|\| !statement) { manualError = $t('gainos.companies.manualRequired'); return; }`（请填写事实内容。） |
| 事实 | 手动依据 | `<input type="text" maxlength=2000>`；默认 `''` | 可选；trim 后非空才提交 |

**确认框（`window.confirm`）**：删除公司 `deleteConfirm`（确认删除这家公司档案？删除后将从列表中移除，事实与审计仍保留。）；删除资料 `documentDeleteConfirm`（删除这份资料？删除后检索不再包含它。）；撤销事实 `revokeConfirm`（撤销这条已通过的事实？下游会停止使用它。）；解决冲突 `conflictConfirm`（确认保留这条事实，并撤销另一条？）。批量“不采用所选”为两次点击武装，不是 confirm。

**按钮**：`cta` 建立档案；`common.retry` 重试；`emptyCta` 开始建档；`facts` 查看档案（REVIEW/ACTIVE）；`complete` 补全资料（DRAFT）；`more` 更多；`documents` 资料库；`retryUnderstanding` 重试理解（understandingFailed）；`confirm` 确认档案（REVIEW）；`edit` 编辑（DRAFT）；`delete` 删除（DRAFT，confirm）；向导取消/创建（`create`/`creating`）；编辑 `autoFind` 自动找官网 / `autoFinding`、`useCandidate` 采用、取消、`save`/`saving`；资料库 `upload`/`uploading`、`download`、`retryUnderstanding`、`delete`、`loadMoreDocuments`、`documentSearch`、`close`；事实 `keepThis` 保留这条（管理员）、Tab `tabPending/tabApproved/tabIgnored`、`manualAdd/manualCancel`、`synthesizeDrafts`、`manualSubmit`、`common.cancel`、`revoke`、全选、`rejectSelected`/`confirmReject`、`approveSelected`、`goFindBuyers`。

**公司表（原生 table，无 dataIndex/key）**

| 列标题键 | 中文 | 内容 |
|---|---|---|
| `colCompany` | 公司 | name / domain / website / `unnamed`；理解失败时追加 `understandingLastError` 或 `statusFailed` |
| `colStatus` | 状态 | `understandingFailed` → `statusFailed`；否则 `status*` 徽章 |
| `colDomain` | 域名 | `website ?? domain ?? '—'`（注意 website 优先） |
| `colIndustry` | 行业 | `industry ?? '—'` |
| `colCreated` | 创建时间 | `formatDate(created_at) ?? '—'` |
| `colActions` | 操作 | 主按钮 + 更多菜单 |

无排序/分页；`showing` 文案；过滤空 `noMatch`。

**资料库列表**：filename、`docSizeLabel` · `docStatusLabel`（`documentStatusPending/Queued/Processing/Ready/Failed/Rejected`）、`documentChunks`、错误码、下载/重试/删除；游标分页 `loadMoreDocuments`；打开后 10s 轮询未完成状态。

**事实列表**：勾选（管理员 + NEEDS_REVIEW）、`claimType.*`、置信度百分比、撤销（管理员 + APPROVED）、statement、evidence snippet、来源 `claimSource`；Tab 计数；无分页。

**冲突列表**：`conflictsTitle`（待处理冲突（{count}））、`conflictsHint`、`claimType`、A/B statements、`keepThis`（管理员）、`conflictsAdminOnly`。

**概览/产品**：`overviewIndustry/overviewMarkets/overviewEmail`、`statApproved/statPending/statOfferings/statConflicts`、`offeringsTitle` / `offeringsEmpty`。

**弹窗**：建档向导（`wizardTitle`/`wizardHint`）；编辑（`editTitle`/`editHint`，自动找官网）；资料库（`documentsTitle` + 公司名 / `documentsHint`，空 `documentsEmpty`，检索空 `documentSearchEmpty`）；事实面板（`factsTitle` {name} 的档案 / `factsHint`，概览 `overviewLoading`/`overviewError`，冲突，Tabs，手动条，搜索，列表，底部 `approvedReady`/`approvedNeed`/`goFindBuyers`）。

**API**

| 方法 | HTTP | 路径 | 时机 |
|---|---|---|---|
| `session()` | GET | `/auth/session` | onMounted（admin） |
| `companies()` | GET | `/companies` | load / 重试 / 删除/创建/编辑/确认/重试后 / ENRICHING 8s 轮询 |
| `createCompany({website?,name?})` | POST | `/companies` | 建档 |
| `updateCompany(id,input)` | PATCH | `/companies/{id}` | 编辑保存 |
| `deleteCompany(id)` | DELETE | `/companies/{id}` | 删除 |
| `retryCompanyUnderstanding(id,attemptId)` | POST | `/companies/{id}/understanding/retry` | 重试理解 / 补官网后启动理解 |
| `companyWebsiteCandidates(id)` | POST | `/companies/{id}/website-candidates` | 自动找官网 |
| `presignSellerDocument(id,{filename,mime,size})` | POST | `/companies/{id}/seller-documents/presign` | 上传第一步 |
| 原始 `fetch` | PUT | `/api/companies/{id}/seller-documents/{documentId}/content` | 上传第二步（硬编码 `/api`） |
| `commitSellerDocument(id,documentId)` | POST | `/companies/{id}/seller-documents/{documentId}/commit` | 上传第三步 |
| `sellerDocuments(id,cursor?)` | GET | `/companies/{id}/seller-documents` | 资料库首屏/更多/轮询 |
| `searchSellerDocuments(id,q,10)` | GET | `/companies/{id}/seller-documents/search?q=&limit=10` | 资料检索 |
| `retrySellerDocument(documentId)` | POST | `/seller-documents/{documentId}/retry` | 资料重试 |
| `deleteSellerDocument(documentId)` | DELETE | `/seller-documents/{documentId}` | 删除资料 |
| `sellerDocumentDownloadUrl(documentId)` | GET | `/seller-documents/{documentId}/download-url` | 下载 |
| `confirmCompany(id)` | POST | `/companies/{id}/confirm` | 确认档案 |
| `companyDetail(id)` | GET | `/companies/{id}` | 打开事实面板 |
| `companyCompleteness(id)` | GET | `/companies/{id}/completeness` | 同上 |
| `companyOfferings(id)` | GET | `/companies/{id}/offerings` | 同上 |
| `claims(id)` | GET | `/companies/{id}/claims` | 打开事实面板 / 各操作后 |
| `createClaim(id,{type,statement,evidence?})` | POST | `/companies/{id}/claims` | 手动补充 |
| `synthesizeClaimDrafts(id)` | POST | `/onboarding/companies/{id}/claim-drafts` | 生成事实草稿 |
| `approveClaim(id)` | POST | `/claims/{id}/approve` | 批量通过 |
| `rejectClaim(id)` | POST | `/claims/{id}/reject` | 批量不采用 |
| `revokeClaim(id)` | POST | `/claims/{id}/revoke` | 撤销 |
| `companyConflicts(id)` | GET | `/companies/{id}/conflicts?status=OPEN` | 打开事实面板 |
| `resolveConflict(id,keep)` | POST | `/conflicts/{id}/resolve` | 解决冲突 |

**Locales keys**：`gainos.common.cancel/loading/retry`；`gainos.companies.*`（title、subtitle、cta、searchPlaceholder、filterAll、statusDraft/Enriching/Review/Active/Failed、showing、emptyTitle/Desc/Cta、noMatch、wizardTitle/Hint、website/name/websitePlaceholder/namePlaceholder、create/creating/created/createdNoUnderstanding、errWebsiteInvalid、errNameOrWebsite、editTitle/Hint、edit/editNotAllowed、industryLabel/Placeholder、businessEmailLabel/Placeholder、targetMarketsLabel/Placeholder、targetMarketsInvalid、save/saving/saved、autoFind/autoFinding/autoFindEmpty/autoFindFailed/autoFindHint、useCandidate、documents/documentsTitle/documentsHint/documentsEmpty、upload/uploading/uploadDone/uploadFailed/uploadFormats、download、retryUnderstanding、delete/deleteConfirm/deleted/deleteFailed、documentDeleteConfirm/documentDeleted/documentRetryDone/documentChunks/documentSearch/documentSearchPlaceholder/documentSearchEmpty/documentStatus*、loadMoreDocuments、close、facts/factsTitle/factsHint/factsLoading?、overviewLoading/overviewError/overviewIndustry/overviewMarkets/overviewEmail、statApproved/statPending/statOfferings/statConflicts、offeringsTitle/offeringsEmpty、conflictsTitle/conflictsHint/conflictsAdminOnly/conflictConfirm/conflictResolved/keepThis、tabPending/tabApproved/tabIgnored、manualAdd/manualCancel/manualStatement/manualStatementHint/manualEvidence/manualEvidenceHint/manualRequired/manualSubmit/manualCreated、synthesizeDrafts/synthesizeDraftsHint/synthesizeDraftsCreated/synthesizeDraftsNone、claimsSearch/claimsLoading/claimsNoMatch/claimsEmptyPending/claimsEmptyApproved/claimsEmptyIgnored/claimsApproved/claimsRejected/claimsPartialFail、claimSource/claimType.*、selectAll/selectClaim/selectedCount、rejectSelected/confirmReject/approveSelected、revoke/revokeConfirm/revoked、approvedReady/approvedNeed/goFindBuyers、claimProgress?、errorWhy、loading、unnamed、claimActionError/claimNotice）。另有 `gainos.findBuyers.technicalDetails`。

**空/错状态**：页面 loading `companies.loading`；错误 `error` + `errorWhy` + retry；空 `emptyTitle/emptyDesc/emptyCta`；过滤空 `noMatch`；文档空 `documentsEmpty`；检索空 `documentSearchEmpty`；事实空 `claimsEmpty*`；冲突空不渲染；产品空 `offeringsEmpty`；审批就绪/不足 `approvedReady`/`approvedNeed`；手动事实错误 `manualRequired`；编辑不允许 `editNotAllowed`；删除失败 `deleteFailed`。

### 2.10 `/growth` — 商机与触达（`Growth`）

**权限**：无 `meta.authority`；页面无角色判断；6 个 tab 全部可见。

**标题/tab**：H1 `gainos.growth.title`（商机与触达）、副标题 `gainos.growth.subtitle`、徽章 `gainos.growth.shadowBadge`（运行期 · 按授权执行）。tab 顺序与文案：

| tab key | 文案来源 | 中文 |
|---|---|---|
| campaigns | `glossaryTerm('campaign')` | 战役计划 |
| opportunities | `glossaryTerm('qgo')` | 商机 |
| outreach | `glossaryTerm('outreach')` | 触达 |
| replies | `gainos.replies.tab` | 回复 |
| reviews | `gainos.reviews.tab` | 判定复核 |
| metrics | `gainos.metrics.tab` | 度量 |

`tab` 与 URL `?tab=` 同步；非法/缺省回落 `campaigns`；切换用 `router.replace`。6 个 tab 均为 `defineAsyncComponent` 懒加载。

**表单**：无。

**按钮**：6 个 `role="tab"` 按钮（`aria-selected`），无禁用。

**API**：无直接 API；由内嵌页各自调用。

**Locales keys**：`gainos.growth.title/subtitle/shadowBadge`、`gainos.replies.tab`、`gainos.reviews.tab`、`gainos.metrics.tab`；共享 glossary 的 campaign/qgo/outreach。

**空/错**：无页面级状态。

#### 2.10.1 `?tab=campaigns`

内嵌 `/campaigns` 的 `campaigns/index.vue`，`embedded=true`：不渲染页头，仅在右侧显示 `gainos.campaigns.newCampaign`（新建计划）。表单、表格列、弹窗、API、空/错状态与 §2.7 完全一致。

#### 2.10.2 `?tab=opportunities`

内嵌 `/qgos` 的 `qgos/index.vue`，`embedded=true`：不渲染页头，仅保留刷新按钮。表单、卡片、抽屉、API、空/错状态与 §2.6 完全一致。

#### 2.10.3 `?tab=outreach` — 触达批次（`outreach/index.vue`）

**权限**：Growth 路由无 `meta.authority`；页面无角色判断（后端写操作为 AdminGuard）。

**标题/文案键**：`gainos.outreach.title`（触达批次）、`subtitle`、`newBatch`、`listTitle`、`empty`、`draftCount`（{count} 封草稿）、`selectHint`、`addDraft`、`edit`、`remove`、`save`、`submit`、`submitted`、`approvalTitle`、`approvalExpires`、`decisionReasonHint`、`approve`、`decline`、`approved`、`declined`、`reopened`、`reopen`、`recipient`、`company`、`subject`、`body`、`status`、`contactRef`、`contactRefHint`、`pickContact`、`pickLeadPlaceholder`、`pickEmpty`、`pickUse`、`noDrafts`、`draftRequired`、`unknownStatus`、`timeline`、`event*`、`eventOther`。

**表单/校验**

| 位置 | 字段 | 控件/默认值 | 校验 |
|---|---|---|---|
| 新建批次（内联） | 批次名称 | `<Input maxlength=200>`；默认 `''`；placeholder `namePlaceholder` | `createBatch()`：`if (!batchName.trim()) return;`；按钮空值禁用；无错误文案 |
| 审批备注 | 备注 | `<Input maxlength=500>`；默认 `''`；placeholder `decisionReasonHint` | 可选；trim 后非空才提交 reason |
| 草稿弹窗 | contactRef | `<Input>`；默认 `''`；placeholder `contactRefHint` | 必填 |
| 草稿弹窗 | recipientEmail | `<Input type="email" maxlength=320>`；默认 `''` | 必填；无额外邮箱正则 |
| 草稿弹窗 | companyName | `<Input maxlength=200>`；默认 `''` | 可选 |
| 草稿弹窗 | subject | `<Input maxlength=300>`；默认 `''` | 必填 |
| 草稿弹窗 | body | `<TextArea rows=6 maxlength=20000>`；默认 `''` | 必填 |

校验原文：`if (!input.contactRef || !input.recipientEmail || !input.subject || !input.body) { draftError = $t('gainos.outreach.draftRequired'); return; }`（联系人标识、收件邮箱、主题和正文都必填。）

联系人选择器：选择线索 `<Select allow-clear>`（首次展开 GET `/leads?queue=recommended&limit=50`）；选择后 GET `/leads/{leadId}/package`，取 `contacts`，选第一个 email 触点写入 contactRef/contactPointId/recipientEmail/companyName。

**按钮**：`newBatch` 新建批次；`create` 创建（`busy==='create'` 或空名称禁用）；`cancel` 取消；批次项（选择）；`addDraft` 添加草稿（canEdit）；`submit` 提交审批（canSubmit）；`reopen` 重新打开（canReopen）；`approve` 批准 / `decline` 拒绝（canDecide）；`edit` / `remove`（canEdit，移除无确认）；`pickContact` / `pickUse`；`save` 保存（草稿弹窗）。

流程条件：`canEdit = status === 'DRAFT'`；`canSubmit = status === 'DRAFT' && draftCount > 0`；`canDecide = status === 'PENDING_APPROVAL' && latestApproval.state === 'PENDING'`；`canReopen = status === 'DECLINED' || 'EXPIRED'`。

**批次列表字段**：name、状态徽章（glossary `outreachBatch`）、`draftCount`。无筛选/排序/分页；空 `empty`；未选 `selectHint`。

**草稿表（AntDV Table，无分页/筛选/排序）**

| 列 key | dataIndex | 标题键 | 内容 |
|---|---|---|---|
| recipient | recipientEmail | `recipient` 收件邮箱 | 原值 |
| company | companyName | `company` 公司 | `companyName ?? '—'` |
| subject | subject | `subject` 主题 | 原值 |
| status | status | `status` 状态 | 徽章 + glossary `outreachDraft` |
| actions | actions | — | 编辑/移除 |

无草稿 `noDrafts`。操作记录 `detail.events`：`event{type}` + `formatDateTime`；未知 `eventOther`。

**弹窗**：草稿 Modal（新增标题 `addDraft`，编辑标题 `edit`；宽 560；字段 contactRef/联系人选择器/recipientEmail/companyName/subject/body；OK `save`，Cancel `cancel`；错误 Alert）。

**API**

| 方法 | HTTP | 路径 | 时机 |
|---|---|---|---|
| `outreachBatches()` | GET | `/outreach/batches` | onMounted / 创建/提交/审批/重开后 |
| `outreachBatch(batchId)` | GET | `/outreach/batches/{batchId}` | 选中批次 / 保存/移除草稿后 / 提交后 |
| `createOutreachBatch({name})` | POST | `/outreach/batches` | 新建批次 |
| `leads({queue:'recommended',limit:50})` | GET | `/leads` | 首次展开联系人选择器 |
| `leadPackage(leadId)` | GET | `/leads/{leadId}/package` | 选择线索 |
| `addOutreachDraft(batchId,input)` | POST | `/outreach/batches/{batchId}/drafts` | 新增草稿 |
| `updateOutreachDraft(batchId,draftId,input)` | PATCH | `/outreach/batches/{batchId}/drafts/{draftId}` | 编辑草稿 |
| `removeOutreachDraft(batchId,draftId)` | DELETE | `/outreach/batches/{batchId}/drafts/{draftId}` | 移除草稿 |
| `submitOutreachBatch(batchId)` | POST | `/outreach/batches/{batchId}/submit` | 提交审批 |
| `decideOutreachBatch(batchId,approvalId,{decision,reason?})` | POST | `/outreach/batches/{batchId}/approvals/{approvalId}/decide` | 批准/拒绝 |
| `reopenOutreachBatch(batchId)` | POST | `/outreach/batches/{batchId}/reopen` | 重新打开 |

**Locales keys**：`gainos.common.loading`；`gainos.outreach.*`（见上列全部键）；状态徽章用 glossary `outreachBatch`/`outreachDraft`。

**空/错**：loading `outreach.loading`；页面错误红色 Alert（title/why/next 拼接，无重试）；空批次 `empty`；未选 `selectHint`；无草稿 `noDrafts`；选择器空 `pickEmpty`；成功 `submitted/approved/declined/reopened`；草稿保存失败弹窗内 Alert。

#### 2.10.4 `?tab=replies` — 回复收件箱（`outreach/replies.vue`）

**权限**：无页面角色判断。**标题**：`gainos.replies.title`（回复收件箱）/ `subtitle`（即使 embedded 也渲染 PageHeader）。

**表单**：无。**按钮**：`common.refresh` 刷新（loading）、`common.retry` 重试。

**表格（AntDV Table，无分页/筛选/排序）**

| 列 key | dataIndex | 标题键 | 内容 |
|---|---|---|---|
| receivedAt | receivedAt | `colTime` 时间 | formatDateTime 或 `—` |
| recipientEmail | recipientEmail | `colRecipient` 收件人 | 值或 `—` |
| classification | classification | `colClass` 分类 | 分类徽章 + kind 文本 |
| subject | subject | `colSubject` 主题 | 主题或 `—`；有 snippet 追加摘要 |

分类 tone：POSITIVE success / NEGATIVE danger / NEUTRAL neutral / OUT_OF_OFFICE warning / UNKNOWN neutral。文案 `replies.class.*`、`replies.kind.*`。

**API**：`outreachReplies()` GET `/outreach/replies`（onMounted/刷新/重试）。

**Locales keys**：`gainos.replies.title/subtitle/empty/colTime/colRecipient/colClass/colSubject/class.POSITIVE/NEUTRAL/NEGATIVE/OUT_OF_OFFICE/UNKNOWN/kind.REPLY/BOUNCE/UNSUBSCRIBE`；`gainos.common.loading/refresh/retry`。

**空/错**：loading；error AsyncSection title/next + retry；empty `replies.empty`（无 CTA）。

#### 2.10.5 `?tab=reviews` — 判定复核（`reviews/index.vue`）

**权限**：无页面角色判断。**标题**：`gainos.reviews.title`（判定复核）/ `subtitle`；stats `statsTitle`、`statQueued`、`statInReview`、`statResolved`（近 {days} 天已复核）、`statOverturn`、`statOverturnValue`（{rate}%（{overturned}/{resolved}））、`statOverturnNone`。

**筛选**：状态 `<select>`（全部 + queued/in_review/resolved/expired，glossary `reviewTask`）；优先级 `<select>`（全部 + 0/1/2/3，glossary `reviewPriority`）；变化即 `load(true)`。

**复核表单**：`resolution.verdict` 三选一 radio（FIT/NOT_FIT/UNKNOWN，默认 `''`，必须选）；`resolution.note` textarea `maxlength=2000 rows=4` placeholder `notePlaceholder`（可选）。`canSubmit = canResolve && verdict !== '' && !resolving`；`submitResolution()` 首行 `if (!selected || verdict === '') return;`。无错误文案。

**按钮**：`common.refresh` 刷新（loading 禁用）；`open` 查看；公司名按钮；`loadMore` 加载更多（游标）；`claim` 认领任务 / `claiming`（queued）；`submit` 提交结论 / `submitting`（in_review，`!canSubmit` 禁用）；`detailClose` 关闭；`common.retry` 重试。

**表格（原生 table）**

| 列标题键 | 中文 | 内容 |
|---|---|---|
| `colPriority` | 优先级 | glossary `reviewPriority` 徽章 |
| `colCompany` | 公司 | 公司名按钮；空 `unknownCompany` |
| `colReason` | 复核原因 | glossary `reviewReason`；缺省 `—` |
| `colJudgeVerdict` | 机器结论 | glossary `reviewVerdict` 徽章 |
| `colStatus` | 状态 | glossary `reviewTask` 徽章 |
| `colSla` | 剩余时间 | `slaNone` / `slaRemaining` / `slaOverdue`，`durationHours/Days/DaysHours` |
| `colActions` | 操作 | `open` |

筛选状态/优先级；游标分页 `limit:50`；无排序控件（顺序以后端为准）。

**抽屉**：标题公司名或 `unknownCompany`；副标题 `detailTitle`（判定详情）；元信息 `filterReason` / `filterPriority` / `colStatus` / `colJudgeVerdict` / `dueAt` / `judgedAt`；判据区 `criteriaTitle`（`criteriaEmpty`、`criteriaScore`、`criteriaScoreNone`、`criteria.*`、`criteriaOther`）；操作区 `actionTitle`（`claimHint` / `resolveHint` / `verdictLabel` / `verdictFit/NotFit/Unknown` / `noteLabel` / `submit`）；已完成 `resolvedReadonly`；已过期 `expiredReadonly`；`detailClose`；Escape 关闭。

**API**：`judgmentReviews({status?,priority?,limit:50,cursor?})` GET `/judgment-reviews`；`judgmentStats(7)` GET `/judgments/stats?window=7`；`judgment(judgmentRecordId)` GET `/judgments/{id}`；`claimJudgmentReview(id)` POST `/judgment-reviews/{id}/claim`；`resolveJudgmentReview(id,{verdict,note?})` POST `/judgment-reviews/{id}/resolve`。

**Locales keys**：`gainos.common.loading/refresh/retry/unknownStatus`；`gainos.reviews.*`（title、subtitle、statsTitle、statQueued、statInReview、statResolved、statOverturn、statOverturnValue、statOverturnNone、filtersTitle、filterStatus、filterPriority、filterReason、all、unknownCompany、colPriority、colCompany、colReason、colJudgeVerdict、colStatus、colSla、colActions、open、emptyTitle、emptyDesc、emptyFiltered、emptyFilteredHint、loadMore、slaNone、slaRemaining、slaOverdue、durationHours、durationDays、durationDaysHours、detailTitle、detailClose、dueAt、judgedAt、detailLoading、criteriaTitle、criteriaEmpty、criteriaScore、criteriaScoreNone、criteriaOther、criteria.C1_MATERIAL/C2_ROLE/C3_PROCESS/C4_BUSINESS_MODEL/C5_SIZE、actionTitle、claimHint、claim、claiming、claimedNotice、resolveHint、verdictLabel、verdictFit、verdictNotFit、verdictUnknown、noteLabel、notePlaceholder、submit、submitting、resolvedNotice、resolvedReadonly、expiredReadonly）。

**空/错**：loading；列表错误自定义块 title/why/next + retry；空（筛选）`emptyFiltered` / `emptyFilteredHint`；空（无筛选）`emptyTitle` / `emptyDesc`；判据 loading/error（title/next + retry）/empty；操作 notice/error（title/why/next，无重试）。

#### 2.10.6 `?tab=metrics` — 度量（`metrics/index.vue`）

**权限**：无页面角色判断。**标题**：`gainos.metrics.title`（度量）/ `subtitle`；内部表格 tab `tabCatalog`（指标目录）/ `tabObservations`（观测）/ `tabRollups`（聚合）。

**表单/筛选**

| 区域 | 字段 | 控件/默认值 | 行为 |
|---|---|---|---|
| VRIC | 粒度 | `<select>`；默认 `daily`；`daily` 按日 / `weekly` 按周 | 变化触发 `loadVric()` |
| VRIC | 分层 | `<select>`；默认 `pickDefaultStratum()` | 仅 `strata.length > 1` 显示；变化只本地重绘 |
| 目录 | 搜索 | `<input type="search">`；默认 `''`；placeholder `catalogSearchPlaceholder` | 客户端匹配 metricId + name |
| 目录 | 层级 | `<select>`；默认 `''` | 全部 + 数据中的 tier |
| 目录 | 状态 | `<select>`；默认 `''` | 全部/ACTIVE/DRAFT/DEPRECATED/RETIRED |
| 观测 | 指标 / 起始日 / 结束日 | `<select>` / `<input type="date">` / `<input type="date">`；默认 `''` | 提交查询或重置 |
| 聚合 | 粒度 | `<select>`；默认 `daily` | 变化且在聚合 tab 时重新请求 |
| 聚合 | 指标 / 起始日 / 结束日 | 同上 | 提交查询或重置 |

所有筛选无校验；查询按钮仅 loading 禁用；重置无禁用。

**按钮**：`common.refresh` 刷新（只刷 VRIC，`vricLoading` 禁用）；`apply` 查询；`reset` 重置；`loadMore` 加载更多（cursor）；`common.retry` 重试（各区块）；表格 tab 切换（首次懒加载）。

**VRIC 区**：`vricTitle` / `vricSub`；`granularity` / `daily` / `weekly`；`stratum`；`latestBucket`；`strict`（严格口径（STRICT））+ 值；`plus`（放宽口径（PLUS））+ 值；`windowTruncated`；ECharts 折线（340px，`connectNulls:false`）；`vricGapNote`（某侧没有数据时折线断开——空白代表缺数据，不代表 0。）；空 `vricEmpty` / `vricEmptyHint`；aria `chartAria` / `chartAriaLatest`。

**目录表（原生 table）**：列 `colMetric` 指标 / `colName` 名称 / `colTier` 层级 / `colUnit` 单位 / `colStatus` 状态 / `colOwner` 负责人 / `colEffective` 生效日期；客户端筛选；无排序/分页；空 `catalogEmpty` / `catalogEmptyHint`。

**观测表**：列 `colMetric` / `colWindow` / `colValue` / `colRatio` / `colCi` / `colSample` / `colComputedAt`；筛选指标/起始/结束；游标分页 50；空 `rowsEmpty` / `rowsEmptyHint`。

**聚合表**：列 `colBucket` / `colMetric` / `colStratum` / `colValue` / `colRatio` / `colSample` / `colRefreshedAt`；筛选粒度/指标/起始/结束；游标分页 50；空 `rowsEmpty` / `rowsEmptyHint`。

**API**

| 方法 | HTTP | 路径 | 时机 |
|---|---|---|---|
| `vricSeries({granularity,limit:30})` | GET | `/metrics/vric` | onMounted / 粒度变化 / 刷新 / 重试 |
| `metricCatalog()` | GET | `/metrics/catalog` | onMounted / 目录重试 |
| `metricObservations({metricId?,from?,to?,limit:50,cursor?})` | GET | `/metrics/observations` | 首次切观测 / 查询 / 重置 / 更多 / 重试 |
| `metricRollups({metricId?,from?,to?,granularity,limit:50,cursor?})` | GET | `/metrics/rollups` | 首次切聚合 / 粒度变化 / 查询 / 重置 / 更多 / 重试 |

**Locales keys**：`gainos.common.loading/refresh/retry/unknownStatus`；`gainos.metrics.*`（title、subtitle、vricTitle、vricSub、granularity、daily、weekly、stratum、stratumDefault、stratumOther、strict、plus、vricEmpty、vricEmptyHint、chartAria、chartAriaLatest、latestBucket、windowTruncated、vricGapNote、tablesTitle、tabCatalog、tabObservations、tabRollups、catalogSearch、catalogSearchPlaceholder、colTier、colStatus、colMetric、colName、colUnit、colOwner、colEffective、all、catalogEmpty、catalogEmptyHint、metricAll、from、to、apply、reset、colWindow、colValue、colRatio、colCi、colSample、colComputedAt、colBucket、colStratum、colRefreshedAt、rowsEmpty、rowsEmptyHint、loadMore、channels.*、tiers.*、units.*）。

**空/错**：VRIC loading/error（title/next + retry）/empty；目录 loading/error/empty；观测/聚合 loading/error/empty；均无内容级 CTA，仅重试/查询/重置。

---

### 2.11 `/tasks` — 挖掘任务列表（`Tasks`）

**权限**：无 `meta.authority`；页面无角色判断。

**标题/文案键**：`gainos.tasks.title`（挖掘任务）、`subtitle`、`empty`（还没有挖掘任务。先到「找买家」设定目标客户画像并发起寻源。）、`emptyCta`（去设定目标客户画像）、`colTask`（任务）、`colStatus`（最近运行）、`colLastRun`（最近运行时间）、`colActions`（操作）、`viewRun`（查看运行）、`noRun`（还没有运行）、`never`（从未）、`runs.icp`（目标客户画像）。

**表单**：无。

**按钮**：`common.refresh` 刷新（loading）；`emptyCta` 去设定目标客户画像 → `/find-buyers`；任务名链接 TaskDetail；`viewRun` 查看运行（有 runId）；错误态 `common.retry`。

**表格（AntDV Table，`:pagination="false"`，无筛选/排序）**

| 列 key | dataIndex | 标题键 | 内容 |
|---|---|---|---|
| name | name | `colTask` 任务 | 名称加粗链接；下方 `runs.icp` + `icpId.slice(0,8)` 或 `—` |
| status | status | `colStatus` 最近运行 | 最近 run 状态徽章（glossary `run`）；无 run `noRun` |
| lastRunAt | lastRunAt | `colLastRun` 最近运行时间 | `formatDateTime`；空 `never` |
| actions | actions | `colActions` 操作 | `viewRun` 或 `—` |

“最近一次 run”= `task.runs` 按 `startedAt` 降序第一条。无分页；服务端 GET `/tasks` 固定 50 条、每任务 runs 20 条。

**弹窗**：无。

**API**：`acquisitionTasks()` GET `/tasks`（onMounted / 刷新 / 重试）。

**Locales keys**：`gainos.menu.tasks`、`gainos.tasks.title/subtitle/empty/emptyCta/colTask/colStatus/colLastRun/colActions/noRun/never/viewRun`、`gainos.runs.icp`、`gainos.common.refresh/loading/retry`。

**空/错**：loading `common.loading`；empty `tasks.empty` + `emptyCta`；error `AsyncSection` title/next + retry（不显示 why）。

---

### 2.12 `/tasks/:taskId` — 任务详情（`TaskDetail`）

**权限**：无 `meta.authority`；`hideInMenu`；页面无角色判断。

**标题/文案键**：页头 `task?.name ?? gainos.tasks.title`；副标题 `detailSubtitle`（这个任务在挖谁、历次运行的结果与重试入口。）；`backToList`、`retryLast`、`retrying`（正在发起…）、`retryRequested`（已发起重试，正在打开新的运行。）、`notFoundTitle` / `notFoundNext`、`colStatus`、`icp`、`createdAt`、`colLastRun`、`never`、`runsCount`、`runHistory`、`colAttempt`、`colRunStatus`、`colTrigger`、`colStarted`、`colFinished`、`noRunYet`。

**表单**：无。

**按钮**：`backToList` 返回任务列表；`retryLast` 重试上次运行（`canRetry` 时；`retrying` 禁用/loading）；错误态 `common.retry`；ICP 链接 `/find-buyers`；运行行 `viewRun`。

`canRetry`：`latestRun` 存在且 status ∈ FAILED/PARTIAL/CANCELLED 且 `Boolean(latestRun.planId)`。

**事实卡**：`colStatus`（taskStatusLabel：`taskActive/Paused/Archived`；大写状态回退原值）、`icp`、`createdAt`、`colLastRun`、`runsCount`。

**运行历史表（AntDV Table，无分页/筛选/排序）**

| 列 key | dataIndex | 标题键 | 内容 |
|---|---|---|---|
| attempt | attempt | `colAttempt` 尝试 | `#{attempt ?? 1}` |
| status | status | `colRunStatus` 结果 | 徽章 + glossary `run` |
| trigger | trigger | `colTrigger` 触发方式 | `trigger.manual/schedule`（其他回退原值） |
| startedAt | startedAt | `colStarted` 开始时间 | formatDateTime 或 `—` |
| finishedAt | finishedAt | `colFinished` 结束时间 | formatDateTime 或 `—` |
| actions | actions | — | `viewRun` 或 `—` |

runs 按 `startedAt` 降序；服务端每任务只回最近 20 条。

**弹窗**：无（重试无确认框；成功用页内 Alert）。

**API**：`acquisitionTasks()` GET `/tasks`（onMounted / 重试 / 无 runId 时刷新）；`startAcquisitionTaskRun(taskId,planId,attemptId)` POST `/tasks/{taskId}/runs`（重试）。任务详情通过列表 `find(row => row.id === taskId)` 获取；未找到 → `notFoundTitle/notFoundNext`。

**Locales keys**：`gainos.tasks.detailTitle/detailSubtitle/title/backToList/retryLast/retrying/retryRequested/notFoundTitle/notFoundNext/colStatus/icp/createdAt/colLastRun/never/runsCount/runHistory/colAttempt/colRunStatus/colTrigger/colStarted/colFinished/noRunYet/viewRun/taskActive/taskPaused/taskArchived/trigger.manual/trigger.schedule`；`gainos.common.loading/retry`。

**空/错**：loading；notFound/请求错误 AsyncSection title/next + retry；运行历史空 `noRunYet`；重试成功 Alert `retryRequested`。

---

### 2.13 `/notifications` — 通知（`Notifications`）

**权限**：无 `meta.authority`；`hideInMenu`；页面无角色判断。

**标题/文案键**：`pageTitle`（通知）、`pageSubtitle`、`markAll`（全部标为已读）、`markAllConfirm`（确认全部已读）、`markAllDone`（已全部标为已读）、`empty`（暂时没有通知。新的进展会在这里提醒你。）、`groupCount`（共 {count} 条）、`default`（通知）。

**表单**：无。

**按钮**：`common.refresh` 刷新（loading）；`markAll` 全部标为已读（unread>0；点击进入内联确认态）；`markAllConfirm` 确认全部已读（POST read-all）；`common.cancel` 取消确认；通知分组整行（标记该组未读并跳转 link）。

分组规则：`${type}:${refId ?? ''}` 合并；`latest` 取 createdAt 最大；`unread` 计数；按 latest.createdAt 降序；无筛选/分页。服务端 GET `/notifications` 固定最近 50 条。

**列表字段**：未读圆点、标题（`titleOf`：en 优先 titleEn，否则 title；无服务端标题则 `notifications.${type}`，未命中 `default`）、合并计数（`groupCount`）、时间（`formatDateTime`）。

**弹窗**：无；“全部标为已读”为页头内联二次确认。

**API**：`notifications()` GET `/notifications`（onMounted/刷新/重试）；`readNotification(id)` POST `/notifications/{id}/read`（点击分组逐条未读）；`readAllNotifications()` POST `/notifications/read-all`（确认全部已读）。`deleteNotification` 未使用。

**Locales keys**：`gainos.notifications.pageTitle/pageSubtitle/markAll/markAllConfirm/markAllDone/empty/groupCount/default`、可能的动态 `notifications.${type}`（runCompleted/runPartial/runFailed/runCancelled/leadQualified/claimApproved/claimRejected/sanctionsHold/quotaWarning/quotaExceeded/sanctionsStale/planJobFailed）、`gainos.common.refresh/cancel/loading/retry`。

**空/错**：loading；empty `notifications.empty`（无 CTA）；error AsyncSection title/next + retry；全部已读成功 Alert `markAllDone`；单条已读失败静默。

---

### 2.14 `/settings/members` — 成员与角色（`SettingsMembers`）

**权限**：路由无 `meta.authority`；设置壳 members 项所有登录用户可见；页面无角色判断。后端邀请/改角色/移除为 AdminGuard（非 admin 会 403）。

**标题/文案键**：壳标题 `gainos.members.title`（成员与角色）/ `subtitle`；`invite`（邀请成员）、`inviteTitle`、`email`、`role`、`roleMember`（成员）/ `roleAdmin`（管理员）、`roleMemberLong` / `roleAdminLong`、`create`（创建邀请）/ `creating`（创建中…）、`errEmail`（请填写有效的邮箱地址）、`membersHeading`（成员）、`pendingHeading`（待接受的邀请）、`joinedAt`（加入于 {date}）、`expiresAt`（{date} 前有效）、`willJoinAdmin`（将加入为管理员）、`willJoinMember`（将加入为成员）、`tipSentHead`（邀请已发送至该邮箱，7 天内有效。把下面的链接转达给同事即可加入：）、`copy`（复制链接）/ `copied`（已复制）、`remove`（移除）、`confirmRemove`（确认移除该成员？对方将立即失去本公司的访问权限。）。

**表单/校验（邀请弹窗）**

| 字段 | 控件/默认值 | 校验 |
|---|---|---|
| 邮箱 | `<Input type="email">`；默认 `''`；placeholder `teammate@company.com` | `/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())`；失败 `inviteError = $t('gainos.members.errEmail')` |
| 角色 | `<RadioGroup>` member/admin，button-style solid；默认 `member` | 无 |

**按钮**：`invite` 邀请成员（打开弹窗）；`common.retry` 重试；`copy` / `copied` 复制邀请链接（2s 恢复）；角色按钮 成员/管理员（点击切换到另一角色；无 disabled，仅样式区分）；`remove` 移除（`window.confirm(confirmRemove)` 后 DELETE）；弹窗取消/创建邀请（`confirm-loading`）。

**列表（卡片，非表格）**：成员行 email、角色中文 · `joinedAt`（日期）；待接受邀请行 email、`willJoin*` · `expiresAt`；无分页/排序/筛选。无空状态文案/CTA（列表为空时成员区为空，邀请区隐藏）。

**弹窗**：邀请成员 Modal（宽 440；字段 email/role；错误 Alert；取消/创建邀请）；移除用原生 confirm。

**API**：`members()` GET `/members`（onMounted/邀请/改角色/移除后）；`inviteMember(email,role)` POST `/members/invite`；`changeRole(id,role)` PATCH `/members/{id}`；`removeMember(id)` DELETE `/members/{id}`。

**Locales keys**：`gainos.members.*`（title、subtitle、invite、inviteTitle、email、role、roleMember、roleAdmin、roleMemberLong、roleAdminLong、create、creating、errEmail、membersHeading、pendingHeading、joinedAt、expiresAt、willJoinAdmin、willJoinMember、tipSentHead、copy、copied、remove、confirmRemove）；`gainos.common.retry/cancel`；壳导航 `gainos.menu.*`。

**空/错**：loading Spin（无文字）；加载失败 Alert warning + retry（替换列表）；邀请失败弹窗内 Alert error；邀请成功顶部 Alert success + 链接 + 复制。

---

### 2.15 `/settings/suppressions` — 禁联名单（`SettingsSuppressions`）

**权限**：路由 `authority: ['admin']`；设置壳 admin 项仅 ADMIN 可见；页面无额外判断；BFF 全部 admin。

**标题/文案键**：`gainos.suppressions.title`（禁联名单）/ `subtitle`；`addTitle`（加入禁联名单）、`typeLabel`、`valueLabel`、`reasonLabel`、`valuePlaceholder.email/domain/company_name`、`add`（加入）、`addHint`、`listTitle`（名单（{count} 条））、`empty`、`colValue/colType/colReason/colProtection/colCreated`、`protectionLegal`（法定）/ `protectionPreference`（偏好）、`type.email/domain/company_name`、`reason.manual/unsubscribe/bounce/complaint/legal`、`release`（解除申请）、`releaseConfirm`（对「{value}」提交解除申请？法定禁联不会物理删除，本次操作会留下审计记录。）、`releaseRequested`、`released`、`releaseHint`、`errValueRequired`（请填写要禁联的内容。）、`errEmail`（邮箱格式不正确。）、`added`（已加入禁联名单，立即生效。）、`loadMore`。

**表单/校验**

| 字段 | 控件/默认值 | 校验 |
|---|---|---|
| 类型 | `<Select>`；默认 `email`；选项 email/domain/company_name | 无 |
| 内容 | `<Input maxlength=2048>`；默认 `''`；placeholder `valuePlaceholder.{type}`；回车触发 add | `value.trim()` 空 → `errValueRequired`；type=email 且不匹配 `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` → `errEmail` |
| 原因 | `<Select>`；默认 `manual`；选项 manual/unsubscribe/bounce/complaint/legal | 无 |

**按钮**：`add` 加入（`adding` 禁用/loading）；`release` 解除申请（行内 link danger；`releasing === id` 禁用/loading；`window.confirm(releaseConfirm)` 后 DELETE）；`common.retry` 重试；`loadMore` 加载更多（`limit += 50` 重新请求，非追加）。

**表格（AntDV Table，`:pagination="false"`，无排序/筛选）**

| 列 key | dataIndex | 标题键 | 内容 |
|---|---|---|---|
| value | value | `colValue` 内容 | 原值 |
| type | type | `colType` 类型 | `type.*`（未知回退原值） |
| reason | reason | `colReason` 原因 | `reason.*`（null/未知 `—`） |
| protectionClass | protectionClass | `colProtection` 保护级别 | LEGAL → `protectionLegal` + warning；否则 `protectionPreference` + neutral |
| createdAt | createdAt | `colCreated` 加入时间 | `formatDate` |
| actions | actions | — | `release` |

`hasMore` 读 `page?.has_more`（响应层级代码存在不确定性，见 agent 备注；改造不得改变请求/取值）。

**弹窗**：无；解除用原生 confirm。

**API**：`suppressions({limit})` GET `/suppressions`（onMounted/加入/解除/更多）；`createSuppression({reason,type,value})` POST `/suppressions`；`requestSuppressionRelease(id)` DELETE `/suppressions/{id}`。

**Locales keys**：`gainos.suppressions.*`（title、subtitle、addTitle、typeLabel、valueLabel、reasonLabel、valuePlaceholder.*、add、addHint、listTitle、empty、colValue、colType、colReason、colProtection、colCreated、protectionLegal、protectionPreference、type.*、reason.*、release、releaseConfirm、releaseRequested、released、releaseHint、errValueRequired、errEmail、added、loadMore）；`gainos.common.loading/retry`。

**空/错**：loading Spin；空 `empty`（无 CTA，上方表单即入口）；加载失败 Alert warning + retry（替换列表，表单仍在）；加入失败表单下 Alert error；成功顶部 Alert success。

---

### 2.16 `/settings/sources` — 数据源（`SettingsSources`）

**权限**：路由 `authority: ['admin']`；设置壳 admin；BFF 导入/启停为 admin，`available` 为 member。

**标题/文案键**：`gainos.sources.title`（数据源）/ `subtitle`；`availableTitle`、`availableDesc`、`availableEmpty`、`enabled`（已启用）/ `enable`（启用）、`enabledNotice` / `disabledNotice`、`crawlGateNote`、`importTitle`、`importDesc`、`chooseFile`、`downloadTemplate`、`mapName/mapWebsite/mapCountry/mapIndustry`、`preview`、`commit`、`previewSummary`、`importResult`、`importDone`、`category.*`、`mode.*`。

**表单/校验**

| 区域 | 字段 | 控件/默认值 | 校验 |
|---|---|---|---|
| 导入 | 文件 | `<Upload accept=".csv,text/csv" :show-upload-list="false" :before-upload="onFile">` | `onFile`：读文本 → 去 BOM → 首行 → 判断分隔符 → headers → autoGuessMapping → return false |
| 映射 | 公司名 | `<Select allow-clear>`；默认 `''` | 必填（标签 ` *`）；`canPreview = csvText.length > 0 && mapping.name !== ''` |
| 映射 | 网站/国家/行业 | `<Select allow-clear>`；默认 `''` | 可选 |
| 自动猜测 | — | — | 表头小写包含 company/name/公司/企业 → name；website/site/url/网站/官网 → website；country/国家 → country；industry/行业 → industry |

**按钮**：`common.refresh` 刷新（loading）；渠道 `enabled`/`enable`（`toggleChannel`；`busyChannel` 禁用/loading）；`chooseFile` 选择 CSV；`downloadTemplate` 下载示例；`preview` 预览（`!canPreview || importBusy` 禁用）；`commit` 提交导入（同上，primary）。

**列表/表格**

- 可用渠道 `ul/li`：name、`category.*` · `mode.*`、启用/已启用；空 `availableEmpty`；下方固定 `crawlGateNote`；无分页/排序/筛选。
- 导入预览表（AntDV Table）：列 `rowNumber`（`#`）、`name`（`mapName`）、`domain`（`mapWebsite`）、`country`（`mapCountry`）；无分页/排序/筛选；`mapIndustry` 只用于映射标签，不在预览列。

**弹窗**：无；渠道启停/导入无二次确认。

**API**：`availableChannels()` GET `/source-channels/available`（onMounted/刷新/启停后）；`enableChannel(id)` POST `/source-channels/{id}/enable`；`disableChannel(id)` DELETE `/source-channels/{id}/enable`；`importTemplate()` GET `/source-channels/import-template`；`previewImport({csv,mapping})` POST `/imported-buyers/preview`；`commitImport({csv,mapping})` POST `/imported-buyers`。

**Locales keys**：`gainos.sources.*`（title、subtitle、availableTitle、availableDesc、availableEmpty、enabled、enable、enabledNotice、disabledNotice、crawlGateNote、importTitle、importDesc、chooseFile、downloadTemplate、mapName、mapWebsite、mapCountry、mapIndustry、preview、commit、previewSummary、importResult、importDone、category.trade_fair/customs/association/directory/tender/other、mode.api/crawl/import）；`gainos.common.refresh/loading`。

**空/错**：loading；渠道空 `availableEmpty`；加载失败 Alert warning title + next（无重试，页头刷新）；启停/下载模板失败 Alert warning；导入错误 Alert warning `title · next`；预览成功 `previewSummary` + sample 表；提交成功 `importResult` + notice `importDone`。

---

### 2.17 `/settings/privacy` — 数据与隐私（`SettingsPrivacy`）

**权限**：路由 `authority: ['admin']`；设置壳 admin；BFF 删除请求 admin，`/companies` member。

**标题/文案键**：`gainos.privacy.title`（数据与隐私）/ `subtitle`；`rightsTitle`、`rightAccess/rightErasure/rightObjection/rightResponse`、`scopeNote`、`formTitle`、`formDesc`、`subjectType`、`subjectCompany`、`subjectContact`、`subjectId`、`subjectIdHint`、`reason`、`reasonErasure/Objection/Legal/Manual`、`requestRef`、`requestRefHint`、`asyncNote`、`submit`（提交删除请求）/ `submitting`（提交中…）、`submitted`、`invalidId`（主体 ID 不是合法 UUID）/ `invalidIdHint`（请从公司或联系人详情复制 UUID）、`refreshing`、`trackedTitle`、`lookupHint`、`found`、`noTracked`、`requestId`、`subject`、`status`、`receipt`、`createdAt`、`receiptSummary`、`unknownStatus`、`trackedNote`。

**表单/校验**

| 字段 | 控件/默认值 | 校验 |
|---|---|---|
| 主体类型 | `<Select>`；默认 `company`；选项 company/contact | 无 |
| 主体 ID | company 且有公司选项时 `<Select show-search>`，否则 `<Input>`；默认 `''`；placeholder `subjectIdHint` | `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`；失败 `formError={title: invalidId, next: invalidIdHint}` |
| 依据 | `<Select>`；默认 `erasure`；选项 erasure/objection/legal/manual | 无 |
| 请求来源引用 | `<Input maxlength=200>`；默认 `''`；placeholder `requestRefHint` | 可选；trim 后非空才加入 payload |
| 查询 | `<Input.Search enter-button>`；默认 `''`；placeholder `lookupHint` | 同样 UUID 正则；失败 `lookupError` |

**按钮**：`common.refresh` 刷新 / `refreshing`（并行 GET 所有 tracked；`refreshing` 禁用/loading）；`submit` 提交删除请求（`submitting` 禁用/loading）；查询按钮（Input.Search enter）；无确认框。

**表格（AntDV Table，`:pagination="false"`，无排序/筛选）**

| 列 key | dataIndex | 标题键 | 内容 |
|---|---|---|---|
| id | id | `requestId` 请求 ID | 等宽 id |
| subject | subject | `subject` 主体 | 原始 `subjectType` + 等宽 `subjectId` |
| status | status | `status` 状态 | 有 details 时原始 status + tone；否则 `unknownStatus` |
| receipt | receipt | `receipt` 回执 | `receiptSummary`（联系人 {contacts} · 联系点 {points} · 证据 {evidence}）或 `—` |
| createdAt | createdAt | `createdAt` 创建时间 | `fmtTime` 或 `—` |

tone：COMPLETED `is-ok` / FAILED `is-bad` / ERASING、FROZEN `is-warn` / 其他 `is-muted`。本地记录 key `gainos.dsr.requests.v1`，最多 50 条。

**弹窗**：无。

**API**：`companies()` GET `/companies`（onMounted，用于下拉；失败静默）；`createDeletionRequest({subjectType,subjectId,reason,requestRef?})` POST `/deletion-requests`；`deletionRequest(id)` GET `/deletion-requests/{id}`（刷新/提交后/查询）。

**Locales keys**：`gainos.privacy.*`（title、subtitle、rightsTitle、rightAccess、rightErasure、rightObjection、rightResponse、scopeNote、formTitle、formDesc、subjectType、subjectCompany、subjectContact、subjectId、subjectIdHint、reason、reasonErasure、reasonObjection、reasonLegal、reasonManual、requestRef、requestRefHint、asyncNote、submit、submitting、submitted、invalidId、invalidIdHint、refreshing、trackedTitle、lookupHint、found、noTracked、requestId、subject、status、receipt、createdAt、receiptSummary、unknownStatus、trackedNote）；`gainos.common.refresh`。

**空/错**：无全局 loading；空 `noTracked`（无 CTA）；提交/查询校验或接口失败 Alert warning title + next；成功 Alert success `submitted/found`；表格下固定 `trackedNote`。

---

### 2.18 `/settings/audit` — 操作审计（`SettingsAudit`）

**权限**：路由 `authority: ['admin']`；设置壳 admin；服务端 TenantGuard + AdminGuard，只返回本人记录。

**标题/文案键**：`gainos.audit.title`（操作审计）/ `subtitle`；`time/action/target/detail`、`empty`（还没有审计记录）、`filterAction`、`filterActionPlaceholder`（例如 member.invite）、`filterFrom`、`filterTo`、`applyFilters`（筛选）、`resetFilters`（重置）、`exportCsv`（导出 CSV）/ `exporting`（导出中…）、`loaded`（已加载 {count} 条）/ `totalLoaded`（共 {count} 条 · 已加载 {loaded} 条）、`loadMore`、`actionName.login/bffRequest/memberInvite/roleChange`。

**表单/筛选**

| 字段 | 控件/默认值 | 行为 |
|---|---|---|
| 动作 | `<Input list="audit-action-options">`；默认 URL query `action` 或 `''`；placeholder `filterActionPlaceholder` | `applyFilters()` trim；datalist 14 个动作：auth.login、bff.request、member.invite、role.change、member.remove、outreach.batch.create、outreach.batch.approve、outreach.draft.create、outreach.send、channel.create、channel.probe、deletion.request、claim.approve、claim.reject |
| 起始日期 | `<DatePicker value-format="YYYY-MM-DD">`；默认 query `from` | 无 |
| 结束日期 | `<DatePicker>`；默认 query `to` | 无 |

筛选点击后写 `applied` + `router.replace({query})`（只写非空）+ `load(true)`；重置清空三者 + 同步 URL + `load(true)`。

**按钮**：`exportCsv` 导出 CSV / `exporting`（entries 为空或 exporting 禁用/loading）；`common.refresh` 刷新；`applyFilters` 筛选（primary submit）；`resetFilters` 重置；`common.retry` 重试；`loadMore` 加载更多（`nextCursor`；`loadingMore` 禁用/loading）。

导出：表头 `time/action/target/detail`；每行 `fmtTime` / `actionLabel` / `shortTarget` / `fmtDetail`；字段双引号转义；`\r\n`；BOM；文件名 `audit-YYYY-MM-DD.csv`；只导出已加载条目。

**表格（AntDV Table，`:pagination="false"`，无前端排序）**

| 列 key | dataIndex | 标题键 | 内容 |
|---|---|---|---|
| at | at | `time` 时间 | `fmtTime` |
| action | action | `action` 动作 | `<code>actionLabel(action)</code>` |
| target | target | `target` 对象 | `shortTarget`（UUID → `#` + 前 8 位），title 原文 |
| detail | detail | `detail` 详情 | null/undefined `—`；字符串原样；对象 JSON.stringify |

`actionLabel` 只映射 4 个：`auth.login` 登录、`bff.request` 业务请求、`member.invite` 邀请成员、`role.change` 角色变更；其他显示原 code。`shortTarget` 只替换 UUID。服务端游标分页 `limit:100`；按 `at desc, id desc`；无排序控件。

**弹窗**：无。

**API**：`audit({action?,from?,to?,cursor?,limit:100})` GET `/audit`（onMounted/筛选/重置/刷新/更多；reset=true 替换 entries，否则追加；reset 失败清空 entries）。

**Locales keys**：`gainos.audit.*`（title、subtitle、time、action、target、detail、empty、filterAction、filterActionPlaceholder、filterFrom、filterTo、applyFilters、resetFilters、exportCsv、exporting、loaded、totalLoaded、loadMore、actionName.login/bffRequest/memberInvite/roleChange）；`gainos.common.refresh/loading/retry`。

**空/错**：loading spinner + `common.loading`；空 `empty`（AntDV Empty simple，无 CTA）；错误 Alert warning title + next + retry；更多按钮。

---

## 3. 认证页（Phase 4）

### 3.1 `/auth/login` — 登录（`Login`）

**权限**：core route，无 `meta.authority`；守卫对 core route 放行；已登录访问会重定向到 `query.redirect` / `homePath`。

**标题/文案键**：路由 `page.auth.login`（登录）；表单标题 `gainos.login.title`（欢迎回来）、`subtitle`；品牌 `gainos.brand.tagline/loginLine1/loginLine2Before/loginLine2Em/loginLine2After/loginDesc/step1Title/step1Desc/step2Title/step2Desc/step3Title/step3Desc`；`email/password/passwordPlaceholder/submit/submitting/showPassword/hidePassword/forgot/forgotHint/noAccount/createWorkspace/terms`。

**表单/校验**

| 字段 | 控件/默认值 | 校验原文 / 错误文案 |
|---|---|---|
| 邮箱 | 原生 `<input type="email" autocomplete="username">`；默认 `''`；placeholder `you@company.com` | `!form.email.trim()` → `errEmailRequired`（请输入工作邮箱）；否则 `/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())` 失败 → `errEmailInvalid`（邮箱格式不正确） |
| 密码 | 原生 `<input :type="showPassword ? 'text' : 'password'" autocomplete="current-password">`；默认 `''`；placeholder `passwordPlaceholder`（至少 10 位，含字母与数字） | `!form.password` → `errPasswordRequired`（请输入密码）；否则 `form.password.length < 10` → `errPasswordShort`（密码至少 10 位）；**不校验字母数字组合** |

表单 `novalidate @submit.prevent`；无 antd Form rules。

**按钮**：`submit` 登录（提交中 disabled + spinner，aria-label `submitting` 登录中）；密码可见性图标（`showPassword`/`hidePassword`）；`forgot` 忘记密码？（仅展开/收起 `forgotHint`，不跳转）；`createWorkspace` 开通企业工作空间 → `/auth/register`；`AuthTools` 语言与主题按钮（主题 aria-label `切换到浅色` / `Switch to dark`）。

**API**：`loginApi({username,password})` POST `/auth/login`（映射 `{email,password}`，用 `baseRequestClient` 避免 401 会话过期链路）；成功后 `getUserInfoApi()` GET `/auth/session`、`getAccessCodesApi()` GET `/auth/session`；页面随后 `router.push('/workspace')`。

**Locales keys**：`gainos.login.*`（title、subtitle、email、password、passwordPlaceholder、submit、submitting、showPassword、hidePassword、forgot、forgotHint、noAccount、createWorkspace、terms、errEmailRequired、errEmailInvalid、errPasswordRequired、errPasswordShort、errUnauthorized、errFailed）；`gainos.brand.*`（见上）；`page.auth.login`；间接 `authentication.loginSuccess/loginSuccessDesc`。

**空/错**：无空态；字段错误 `role="alert"`；提交失败 `p.g-failure[role="alert"]`（401/403 → `errUnauthorized`；否则 userCopy title/next 或 message 或 `errFailed`）；忘记密码仅提示（内测阶段密码由公司管理员重置）。

### 3.2 `/auth/register` — 注册 / 接受邀请（`Register`）

**权限**：core route，无 `meta.authority`；未登录可访问；页面无角色判断。

**标题/文案键**：路由 `page.auth.register`（注册）；普通 `gainos.register.title`（创建账号）/ `subtitle`；邀请模式 `inviteTitle`（接受邀请）/ `inviteSubtitle`；品牌 `gainos.brand.registerLine1/registerLine2Before/registerLine2Em/registerLine2After/registerDesc/regStep1Title/regStep1Desc/regStep2Title/regStep2Desc/regStep3Title/regStep3Desc`。

**表单/校验**

| 字段 | 控件/默认值 | 显示条件 | 校验原文 / 错误文案 |
|---|---|---|---|
| 公司名称 | 原生 `<input type="text">`；默认 `''`；placeholder `companyPlaceholder`；label 附 `companyHint`（将作为公司名称） | `!inviteToken` | `trim().length >= 2`，否则 `errCompanyRequired`（请填写公司名称（至少 2 个字）） |
| 工作邮箱 | 原生 `<input type="email" autocomplete="username">`；默认 `''`；placeholder `you@company.com` | `!inviteToken` | 空 → `errEmailRequired`（请输入工作邮箱）；否则邮箱正则失败 → `errEmailInvalid`（邮箱格式不正确） |
| 设置密码 | 原生 `<input type="password" autocomplete="new-password">`；默认 `''`；placeholder `passwordPlaceholder`（至少 10 位，含字母与数字） | 始终 | `len >= 10 && /[a-zA-Z]/ && /\d/`，否则 `errPassword`（密码至少 10 位，且包含字母与数字） |
| 邀请码 | 原生 `<input type="text">`；默认 `''`；placeholder `inviteCodePlaceholder`；label 附 `inviteCodeOptional`（内测阶段选填） | `!inviteToken && inviteCodeRequired` | 无校验；提交 trim 后非空才传 |

`inviteToken = route.query.invite`；邀请模式只显示密码字段。`inviteCodeRequired` 来自 GET `/auth/registration-policy`，失败按 false。

**按钮**：submit `注册` / 邀请模式 `加入团队`（`submitting` 禁用 + spinner，aria-label `submitting`）；`goLogin` 直接登录 → `/auth/login`；企业已存在块内 `enterpriseExists.goLogin` 已有账号？去登录；AuthTools。

**API**：`registrationPolicy()` GET `/auth/registration-policy`（onMounted）；邀请模式 `acceptInviteApi({token,password})` POST `/auth/accept-invite`，成功后 `session()` GET `/auth/session`、`getUserInfoApi()` GET `/auth/session`，写入 access codes；普通模式 `registerApi({companyName,email,password,inviteCode?})` POST `/auth/register`，成功后 `authStore.authLogin` POST `/auth/login`；最后 `router.push('/workspace')`。

**Locales keys**：`gainos.register.*`（title、subtitle、inviteTitle、inviteSubtitle、company、companyHint、companyPlaceholder、email、password、passwordPlaceholder、inviteCode、inviteCodeOptional、inviteCodePlaceholder、submit、submitInvite、submitting、haveAccount、goLogin、errCompanyRequired、errEmailRequired、errEmailInvalid、errPassword、errFailed、enterpriseExists.title/why/next/goLogin）；`gainos.brand.*`（见上）；`page.auth.register`；间接登录成功通知。

**空/错**：字段错误 `role="alert"`；提交失败 `p.g-failure[role="alert"]`；409 `COMPANY_WORKSPACE_EXISTS` → `div.g-enterprise-exists[role="alert"]`：`enterpriseExists.title`（贵司已开通工作空间）/ `why`（「{name}」已于 {date} 开通工作空间。按一企一空间原则，同一企业只有一个工作空间，同事通过邀请加入。）/ `next`（请联系贵司管理员在「设置 → 成员」生成邀请链接；若这不是贵司的工作空间，请联系运营。）+ `goLogin`。

### 3.3 `/auth/forget-password` — 找回密码（当前不可达）

- 路由为 `{ name: 'ForgetPassword', path: 'forget-password', redirect: LOGIN_PATH }`，**无 component**；`views/_core/authentication/forget-password.vue` 不被任何路由引用。
- 若直接渲染该组件：标题 `authentication.forgetPassword`、副标题 `authentication.forgetPasswordSubtitle`、提交 `authentication.sendResetLink`、返回 `common.back`；字段仅邮箱（zod：min 1 → `authentication.emailTip` 请输入邮箱；email → `authentication.emailValidErrorTip` 你输入的邮箱格式不正确）。
- **无 API 调用**；页面 `handleSubmit` 为空实现，提交只做表单校验。
- 结论：Phase 4 不能在不改路由 redirect 的前提下“改造找回流程”。可选做法：只重构该不可达组件（无用户可见效果），或把登录页的 `forgotHint` 作为找回路径。**需产品确认**（见 §7）。

---

## 4. 非产品路由（保持现状，不在本次视觉改造范围）

| 路由 | 组件 | 说明 |
|---|---|---|
| `/onboarding` | `views/onboarding/index.vue` | 注册引导向导；`noBasicLayout`、`ignoreAccess`；使用 `onboardingStatus` / `completeOnboarding` / `startOnboardingPreview` / `onboardingPreview` 等 API。改造时只允许继承全局 token，不重组结构和文案。 |
| `/ops` | `views/ops/index.vue` | 平台运营台；`noBasicLayout`、`ignoreAccess`；零术语扫描豁免；技术工作面，保持现状。 |
| `/`、`/auth`、`/:path(.*)*` | Basic/Auth layout、404 | 保持现状；全局 token 会自然影响 AntDV 组件。 |

---

## 5. API 调用总表（按 BFF 路径去重）

> 标记 `[写]` 的为 POST/PATCH/DELETE。所有路径均为 `gainos.ts` / `auth.ts` 的字面量；运行时前缀为 `VITE_GLOB_API_URL`。

| 路径 | 方法 | 使用页面 |
|---|---|---|
| `/auth/session` | GET | workspace、leads、companies、login、register（间接） |
| `/auth/login` | POST | login、register（普通注册后自动登录） |
| `/auth/register` | POST | register |
| `/auth/accept-invite` | POST | register（邀请模式） |
| `/auth/registration-policy` | GET | register |
| `/auth/switch-workspace` | POST | 未在本次盘点页面使用 |
| `/companies` | GET/POST | workspace、find-buyers、companies、privacy、register 后 |
| `/companies/{id}` | GET/PATCH/DELETE | companies |
| `/companies/{id}/understanding/retry` | POST | companies |
| `/companies/{id}/website-candidates` | POST | companies |
| `/companies/{id}/seller-documents/presign` | POST | companies |
| `/companies/{id}/seller-documents/{documentId}/content` | PUT（原始 fetch，硬编码 `/api`） | companies |
| `/companies/{id}/seller-documents/{documentId}/commit` | POST | companies |
| `/companies/{id}/seller-documents` | GET | companies |
| `/companies/{id}/seller-documents/search` | GET | companies |
| `/seller-documents/{documentId}/retry` | POST | companies |
| `/seller-documents/{documentId}` | DELETE | companies |
| `/seller-documents/{documentId}/download-url` | GET | companies |
| `/companies/{id}/confirm` | POST | companies |
| `/companies/{id}/completeness` | GET | workspace、companies |
| `/companies/{id}/offerings` | GET | companies |
| `/companies/{id}/claims` | GET/POST | find-buyers、companies |
| `/claims/{id}/approve`、`/claims/{id}/reject`、`/claims/{id}/revoke` | POST | companies |
| `/companies/{id}/conflicts` | GET | companies |
| `/conflicts/{id}/resolve` | POST | companies |
| `/onboarding/companies/{id}/claim-drafts` | POST | companies |
| `/companies/{id}/icps` | POST | find-buyers |
| `/icps` | GET | workspace、find-buyers、leads、campaigns/detail |
| `/icps/{id}` | GET/PATCH | find-buyers |
| `/icps/{id}/activate` | POST | find-buyers |
| `/icps/{id}/rules` | POST | find-buyers |
| `/icp-rules/{id}` | PATCH/DELETE | find-buyers |
| `/icps/{id}/backtests` | POST | find-buyers |
| `/icps/{id}/query-plans` | GET/POST | workspace、find-buyers |
| `/query-plans/{id}/confirm` | POST | find-buyers |
| `/icps/{id}/feedback` | GET | find-buyers |
| `/icps/{id}/lead-queues` | GET | workspace、leads |
| `/leads` | GET | workspace、leads、outreach |
| `/leads/{id}/package` | GET | leads/detail、outreach |
| `/leads/{id}/accept`、`/leads/{id}/reject` | POST | leads、leads/detail |
| `/leads/{id}/sanctions-review` | POST | leads/detail |
| `/leads/{id}/outreach-drafts` | GET/POST | leads/detail |
| `/runs` | GET/POST | workspace、find-buyers |
| `/tasks` | GET/POST | workspace、find-buyers、tasks、tasks/detail |
| `/tasks/{id}/runs` | POST | find-buyers、runs、tasks/detail |
| `/discovery-runs/{id}` | GET | workspace、runs |
| `/discovery-runs/{id}/events` | GET | runs |
| `/discovery-runs/{id}/jobs` | GET | runs |
| `/runs/{id}/trace` | GET | runs |
| `/discovery-runs/{id}/cancel` | POST | runs |
| `/qgos` | GET/POST | qgos、leads、leads/detail |
| `/qgos/{id}` | GET | qgos |
| `/qgos/{id}/accept`、`/qgos/{id}/decline` | POST | qgos |
| `/saos/{id}/outcomes` | POST | qgos |
| `/campaigns` | GET/POST | campaigns |
| `/campaigns/{id}` | GET | campaigns/detail |
| `/campaigns/{id}/plan-drafts` | POST | campaigns/detail |
| `/campaigns/{id}/plan-drafts/{jobId}` | GET | campaigns/detail |
| `/campaigns/{id}/revisions/{revisionId}/submit` | POST | campaigns/detail |
| `/campaigns/{id}/approvals/{approvalId}/decide` | POST | campaigns/detail |
| `/campaigns/{id}/trace` | GET | 未在本页使用（API 存在） |
| `/outreach/batches` | GET/POST | outreach |
| `/outreach/batches/{id}` | GET | outreach |
| `/outreach/batches/{id}/drafts` | POST | outreach |
| `/outreach/batches/{id}/drafts/{draftId}` | PATCH/DELETE | outreach |
| `/outreach/batches/{id}/submit` | POST | outreach |
| `/outreach/batches/{id}/approvals/{approvalId}/decide` | POST | outreach |
| `/outreach/batches/{id}/reopen` | POST | outreach |
| `/outreach/replies` | GET | replies |
| `/judgment-reviews` | GET | reviews |
| `/judgment-reviews/{id}/claim` | POST | reviews |
| `/judgment-reviews/{id}/resolve` | POST | reviews |
| `/judgments/{id}` | GET | reviews |
| `/judgments/stats` | GET | reviews |
| `/metrics/vric` | GET | metrics |
| `/metrics/catalog` | GET | metrics |
| `/metrics/observations` | GET | metrics |
| `/metrics/rollups` | GET | metrics |
| `/notifications` | GET | workspace、notifications |
| `/notifications/{id}/read` | POST | workspace、notifications |
| `/notifications/read-all` | POST | workspace、notifications |
| `/notifications/{id}` | DELETE | 未使用（API 存在） |
| `/members` | GET | workspace、settings/members |
| `/members/invite` | POST | settings/members |
| `/members/{id}` | PATCH/DELETE | settings/members |
| `/suppressions` | GET/POST | settings/suppressions |
| `/suppressions/{id}` | DELETE | settings/suppressions |
| `/source-channels/available` | GET | settings/sources |
| `/source-channels/{id}/enable` | POST/DELETE | settings/sources |
| `/source-channels/import-template` | GET | settings/sources |
| `/imported-buyers/preview` | POST | settings/sources |
| `/imported-buyers` | POST | settings/sources |
| `/imported-buyers/{batchId}` | GET | 未在本页使用（API 存在） |
| `/deletion-requests` | POST | settings/privacy |
| `/deletion-requests/{id}` | GET | settings/privacy |
| `/audit` | GET | settings/audit |
| `/settings/compliance` | GET | leads/detail（DecisionMakerCard） |
| `/canonical-companies/{id}` | GET | leads/detail（DecisionMakerCard） |
| `/canonical-companies/{id}/discover-contacts` | POST | leads/detail（DecisionMakerCard） |
| `/canonical-companies/{id}/guess-emails` | POST | leads/detail（DecisionMakerCard） |
| `/contact-points/{id}/verify` | POST | leads/detail（DecisionMakerCard） |

---

## 6. 权限矩阵（前端事实）

| 路由/操作 | 路由 meta | 页面内角色判断 | 服务端守卫（盘点事实） |
|---|---|---|---|
| `/workspace` | 无 | `isAdmin` 影响 sanctions 计数/最近线索 | TenantGuard |
| `/find-buyers` | 无 | 无 | TenantGuard（写操作按 BFF 表） |
| `/runs/:runId` | 无 | 无 | TenantGuard |
| `/leads` | 无 | `isAdmin` 仅控制 sanctions_hold 队列与 banner | TenantGuard |
| `/leads/:leadId` | 无 | `isAdmin` 控制 people tab 与制裁复核 | TenantGuard；决策人接口要求 compliance:manage |
| `/qgos` | 无 | 无 | TenantGuard |
| `/campaigns` / `/campaigns/:id` | 无 | 无 | GET TenantGuard；写 AdminGuard |
| `/companies` | 无 | `isAdmin` 控制事实审批/冲突/撤销 | TenantGuard；AdminGuard 视操作 |
| `/growth` 及 tabs | 无 | 无 | 各内嵌页见上 |
| `/tasks` / `/tasks/:id` | 无 | 无 | TenantGuard |
| `/notifications` | 无 | 无 | TenantGuard |
| `/settings/members` | 无 | 无（所有登录用户可见） | GET TenantGuard；邀请/改角色/移除 AdminGuard |
| `/settings/suppressions` | `['admin']` | 无（壳过滤） | 全部 admin |
| `/settings/sources` | `['admin']` | 无（壳过滤） | available member；启停/导入 admin |
| `/settings/privacy` | `['admin']` | 无（壳过滤） | 删除请求 admin；`/companies` member |
| `/settings/audit` | `['admin']` | 无（壳过滤） | TenantGuard + AdminGuard；只返回本人记录 |
| `/auth/login`、`/auth/register` | 无 | 无 | 公开 |

> 前端未按角色隐藏的按钮（非管理员点击会由后端 403）：`/campaigns` 新建/起草/提交/审批、`/settings/members` 邀请/改角色/移除、`/settings/sources` 导入/启停等。改造不得改变这些行为的可见性/调用方式，除非作为独立的功能修复并在 PR 说明。

---

## 7. 已确认决策（2026-11-22）

1. **找回密码**：保持 `/auth/forget-password` 的 redirect 不变；登录页的「忘记密码？」提示即找回路径（内测由管理员重置）。进一步按用户指示，登录/注册页本身不改造，Phase 4 只做设置五页。
2. **locales 新增 key**：允许**只新增** key，zh-CN 与 en-US 同步；既有 key/value 一律不改。新增 key 在 P5 清单中列明。
3. **`/outreach` 死链**：保持现状，不改 spec；该 spec 当前通过（404 页面无横向溢出）。不新增 `/outreach` 路由。
4. **基线修复**：已作为 P0 提交 `cf83bf5` 的一部分（3 处 typecheck 修复）；不改变业务行为。
5. **/ops 与登录/注册**：不改造；只允许继承全局 token 的自然影响。用户登录后的系统内页面为主要改造对象。
6. **文案原则**：按 `AGENTS.md` §5.1 砍掉标语、提示文字和次要标签；靠布局表达。功能性标签、校验规则、错误/空状态、操作入口、API 调用不得删除。

---

## 8. 改造后对零清单（P5 填写）

> 规则：逐路由逐项核对；任何差异必须写“保留/替代/删除原因”。P0 只建立表头，P2–P5 逐项填。

| 路由 | 功能项 | 改造前（本文件） | 改造后 | 差异/说明 |
|---|---|---|---|---|
| `/workspace` | 数据接口（14 个） | §2.1 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/workspace` | 通知已读/全部已读 | §2.1 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/workspace` | KPI 跳转目标 6 个 | §2.1 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/find-buyers` | ICP 创建/激活/编辑 | §2.2 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/find-buyers` | 规则 CRUD + 回测 | §2.2 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/find-buyers` | 方案生成/确认/执行 | §2.2 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/runs/:runId` | 轮询/停止/重试/过程 | §2.3 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/leads` | 队列/裁决/提升商机/分页 | §2.4 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/leads/:leadId` | 4 tabs/裁决/草稿/制裁/决策人 | §2.5 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/qgos` | 状态筛选/接受/拒绝/结果 | §2.6 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/campaigns` | 创建/列表 CTA | §2.7 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/campaigns/:id` | 起草/提交/批准/拒绝/时间线 | §2.8 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/companies` | 建档/编辑/资料/事实/冲突 | §2.9 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/growth` | 6 tab 可深链 | §2.10 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/tasks` | 列表/最近运行 | §2.11 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/tasks/:id` | 历史/重试 | §2.12 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/notifications` | 分组/已读/全部已读 | §2.13 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/settings/members` | 邀请/改角色/移除 | §2.14 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/settings/suppressions` | 加入/解除申请/更多 | §2.15 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/settings/sources` | 渠道启停/导入预览/提交 | §2.16 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/settings/privacy` | 删除请求/查询/本地跟踪 | §2.17 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/settings/audit` | 筛选/导出/更多 | §2.18 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/auth/login` | 登录/校验/忘记密码提示 | §3.1 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| `/auth/register` | 注册/邀请/企业已存在 | §3.2 | ✅ 对零 | 见 p2/p3/p4 对零文档 |
| legacy 7 条 | redirect 目标 | §0.2 | ✅ 对零 | 见 p2/p3/p4 对零文档 |

---

## 9. 改造前基线修复记录（P0）

为满足“每个 Phase 末尾 typecheck 全绿”的前置条件，P0 对既有基线做了 3 处最小修复（不改变业务行为）：

1. `apps/web/src/views/runs/index.vue`：模板中 `run.icpId` / `run.planId` / `run.id` 改为可选链/`v-if="run"`，消除 5 处 `TS18047`。
2. `apps/web/src/views/workspace/index.vue`：删除 `kpis` 中未使用的 `const link = latestRunLink.value;`，消除 `TS6133`。
3. `apps/web/src/env.d.ts`：为 Vben 的 `vxe-pc-ui/lib/language/en-US` 与 `zh-CN` 增加模块声明，消除框架侧 `TS7016`。

> 基线命令结果（修复后）：`pnpm typecheck` ✅、`pnpm build` ✅、`pnpm lint:terms` ✅、`pnpm lint:date` ✅；`pnpm e2e:nav` 见 P0 提交说明。





---

## 10. P5 最终对零声明（2026-11-22）

### 10.1 路由

- 产品路由 19 条（含 `/settings` 与 5 个子页）与 legacy 7 条重定向：**path / name / component 未改、未增、未删**。
- `/auth/forget-password` 仍是 redirect 到 `/auth/login`，未按禁令改动。
- `/ops`、`/auth/login`、`/auth/register`、`/onboarding` 未改造；只继承全局 AntDV token 的自然影响。
- 侧边栏分组是 Vben 菜单数据层的展示变换（`use-menu-groups.ts`），不新增嵌套路由。

### 10.2 受保护路径

`git diff ecebda2..HEAD -- apps/web/src/api apps/server packages/engine-client apps/web/src/store apps/web/src/router/guard.ts apps/web/src/router/access.ts apps/web/src/router/routes` 输出为空：
- `api/` 一行未动；
- `apps/server/**`、`packages/engine-client/**` 未动；
- `store/**` 业务逻辑未动；
- `router/guard.ts`、`router/access.ts`、所有路由模块未动。

### 10.3 Locales

- 既有 key 与 value **零改动**：`git diff -U0 ecebda2..HEAD -- apps/web/src/locales` 无删除行。
- 仅新增 key（zh-CN / en-US 同步）：
  - `gainos.menu.groupWorkspace/groupAcquisition/groupLeads/groupActivity/groupGrowth/groupSettings`
  - `gainos.workspace.cockpitToday/cockpitStages/cockpitActions/cockpitAlerts/cockpitSuggestion/cockpitDataSynced/cockpitDataSyncing/cockpitDataFailed/cockpitTodo/cockpitArchived/cockpitArchive/cockpitRestore/cockpitActionsEmpty/cockpitActionsArchivedEmpty/cockpitAlertAbnormal/cockpitAlertOpportunity/cockpitAlertSuggestion`
  - `gainos.members.emptyTitle`

### 10.4 功能差异（均为有意变更，已逐项记录）

| 差异 | 依据 | 记录 |
|---|---|---|
| 侧边栏从扁平 7 项改为 6 个业务分组（叶子项不变） | 任务视觉规格 | `p1` 提交 + `nav-shell`/`main-chain` 测试按分组展开 |
| `/workspace` 删除问候标语、pipelineSummary、KPI 可见 hint、nextAction desc、通知 emoji；新增阶段漏斗/行动清单归档/提醒分类/同步状态 | AGENTS §5.1 简单性原则 | `p2-workspace-parity.md` |
| 列表空状态增加 2–3 条真实路径 | 任务交互规格 + 准则第 6 条补充 | `p3-list-detail-parity.md` |
| 设置页去掉重复的页内二级导航，统一主侧栏「设置」分组 | AGENTS §5.1；避免重复导航 | `p4-settings-parity.md` |
| 设置页空响应改为空态（audit/suppressions/members/sources/privacy） | 防错/健壮性；不改 API | `p4-settings-parity.md` |
| 登录页「忘记密码？」提示作为找回路径；登录/注册不改造 | 用户 2026-11-22 决策 | `inventory.md` §7 |
| `nav-shell` / `main-chain` / `settings-shell` 测试按新 IA 展开分组 | 侧边栏分组后的等价断言 | 对应 spec 注释 |

### 10.5 质量门

- `pnpm typecheck` ✅
- `pnpm build` ✅
- `pnpm lint:terms` ✅
- `pnpm lint:date` ✅
- `pnpm e2e:nav`：**149 passed / 1 skipped**（P5 最终运行）。P2 全量曾出现 1 次 `leads-detail` 并发抖动，单独复跑通过。
- a11y：WCAG 2.x A/AA 抽样全部通过；对比度修复见 `1a5a899`。
- 深色：`dark-mode` 通过；所有新样式同时提供 `.dark` 值。
- 响应式：`responsive` 通过；390×844 无横向溢出。

### 10.6 已知待人工验收

最终验收要求“没看过文档的人独立完成主流程：登录 → 工作空间 → 发起获客 → 查看线索详情 → 处理提醒”。自动化已覆盖主链路，但“点击次数/是否需要口头解释”必须由真实用户完成；本文件不替代该人工验收。


---

## 11. Pass2 修复对零（2026-11-22）

### 11.1 修复 1：主题色统一

- 品牌蓝只保留 `#335CFF` + hover/active `#3559E9`（blue-600）+ 浅底/描边衍生档；删除 `#2547D0`、`#1F3BAD`、`#4D82FF`、`#2563eb`、`#4f46e5` 等第二套蓝。
- success 只保留一个绿 `#1A7544`（AntDV `colorSuccess` 同值），删除 `#1FC16B` / `#3EE089` / `#00B96B` / `#008f52` / `#e8f9f0` / `#dcfce7` 等装饰绿。
- warning 只保留 `#B75310`，error 只保留 `#D02533`；删除 `#FA7319` / `#FFA468` / `#FB3748` / `#FF6875` 等硬编码色。
- logo / favicon / apple-touch-icon / 登录注册品牌面板 / loading 页：装饰性绿全部改为品牌蓝或中性灰；登录/注册结构、文案、行为未改。
- Vben 壳层中性 token 覆盖为纯中性灰（`--foreground`/`--muted-foreground`/`--border` 等），避免 zinc/slate 的第二套灰。
- `apps/web/src/api/core/user.ts` 的 `initialAvatar` 仍使用旧绿色（本轮禁止修改 api/）；在 `layouts/basic.vue` UI 层把 data URI 中的旧绿归一为 `#335CFF`，渲染结果不再出现绿色。
- **源码扫描**：`docs/evidence/ui-restyle/pass2/source-color-scan.py`，85 个文件，0 违规。
- **渲染 DOM 扫描**：`apps/web/e2e/pass2-color-scan.spec.ts`，15 个页面 × 明暗两主题，10,963 个颜色样本；分类：中性 10,249 / 品牌蓝 686 / success 12 / warning 14 / error 2；**unknown 0**。结果：`color-scan.txt` / `color-scan.json`。

### 11.2 修复 2：菜单/卡片/按钮/列表

- 侧边栏：6 个分组标签（36px 行高、11px/500/字距 0.08em、subtle 灰）；叶子菜单项 32px、水平 padding 8px、14px/500；active = 品牌蓝左指示条 3px + 蓝字 + `#F5F5F5` 浅灰底；hover 浅灰。
- 卡片：1px `#EBEBEB` 边 + `0 1px 2px rgba(10,10,10,.03)` 阴影 + 10px 圆角；大容器/弹层保持 20px。
- 主行动按钮：9999px 全圆（含 AntDV `type="primary"` 与页面原生主按钮）；次按钮保持描边/10px。
- `/leads`：删除 5 张常驻队列卡，改为页头下工具栏：队列 chips（原 5 个队列、计数、点击语义不变）+ 搜索框；表格/列表通栏。搜索为**纯前端过滤已加载线索**（公司名/域名/国家），不新增 API、不改变队列筛选语义。
- 量测：`measurements.json`（groupLabel 36 / title 11px / leaf 32 / weight 500 / active bar 3px / card 10px+1px+shadow / main CTA 9999px / `/leads` queueCards 0、toolbar 1、search 1）。

### 11.3 修复 3：Sondara 闭环

- 今日建议（位于提醒之后）：一句话 `nextAction.title` + 全圆主按钮「立即处理」，点击 `router.push(nextAction.to)`。交互测试已点通到 `/companies`。
- 经营提醒：每条为「主行 + 右侧去处理按钮」；主行/按钮均可点击，通知类先调 `POST /notifications/:id/read` 再按 link 跳转。交互测试已点通到 `/leads`，并断言 read 调用 1 次。
- 今日行动清单：所有条目由现有业务状态派生，**没有完成 API**；本轮保持只读，行内标注「在目标页完成」，不伪造完成状态。用户到目标页完成操作后返回工作台，`load()` 重新派生，清单与「今日脉搏 · 待办」计数同步更新。此只读决定即本条要求的标注。
- 所有跳转目标已对照路由基线：`/companies`、`/find-buyers`、`/tasks`、`/leads?queue=...`、`/runs/:id`、`/workspace`，无新增路由、无死链。

### 11.4 功能守恒

- `api/`、`apps/server/**`、`packages/**`、`store/**`、`router/guard.ts`、`router/access.ts`、所有路由模块：**零改动**。
- 既有 locales key 与 value：**零改动**；「立即处理」「去处理」「在目标页完成」为组件内按 `preferences.app.locale` 生成的展示文案，未新增/修改 locale key。
- 表单字段/校验/表格列/弹窗/权限点：未改。
- 有意展示差异：删除 `/leads` 常驻队列卡（改为 chips+搜索）、侧边栏分组标签/尺寸、登录注册 ops 仅颜色归一、行动清单只读标注。均已在本节记录。

### 11.5 质量门

- `pnpm typecheck` ✅
- `pnpm build` ✅
- `pnpm lint:terms` ✅
- `pnpm lint:date` ✅
- `pnpm e2e:nav` ✅：152 passed / 1 skipped（153 个用例，含 3 个 pass2 新增 spec；1 skipped 为真栈冒烟）

### 11.6 证据

- 前后对比：`docs/evidence/ui-restyle/pass2/before-*.png` / `after-*.png`（workspace、leads、settings/members，明暗各一套）。
- 颜色：`color-scan.txt` / `color-scan.json` / `source-color-scan.txt` / `source-color-scan.py`。
- 量测：`measurements.json`。
- 交互：`apps/web/e2e/pass2-interactions.spec.ts`（自动化点通）。


---

## 12. Pass3 修复对零（2026-11-22）

### 12.1 修复 A：缓存强制归一（根因）

- **根因**：Vben 偏好合并是「localStorage 缓存优先于代码默认」；老访客把旧版绿色 `theme.colorPrimary`（经内联 `--primary` 驱动 nprogress 进度条/壳层派生色）与旧布局（header-nav 顶栏菜单）一直带在身上。logo 为同 URL 图片缓存（内容已改蓝但 URL 未变）。
- **方案（b：initPreferences 后强制 merge）**：`main.ts` 在 `initPreferences` 之后调用 `updatePreferences(BRAND_PREFERENCES)`，无条件覆盖 `theme.colorPrimary=#335CFF`、`theme.builtinType=default`、`logo.source/sourceDark=/logo-gainos.svg?v=pass3`、`app.layout=sidebar-nav`，并随 debounce 回写缓存。`theme.mode`（明暗）、`sidebar.width/collapsed`、语言等用户偏好不动。未选方案 (a) 版本号 key：会一次性丢掉用户全部偏好（含明暗/语言），违反「保留用户选择」。
- **代码级绿清零**：`api/core/user.ts:18` 头像兜底 `#00B96B` → `#335CFF`（任务点名要求的一行；除此之外 api/ 零改动）。
- **A4 回归测试**：`pass3-cache-normalize.spec.ts` 预置旧缓存（含 StorageManager `{value:…}` 信封格式）→ 断言进度条色 `rgb(51,92,255)`、侧边栏渲染、banner 无菜单项、logo URL 带版本、明暗切换不受影响、归一结果已回写缓存。**已做反向验证**：临时禁用 `updatePreferences(BRAND_PREFERENCES)` 后该测试变红，恢复后变绿——测试确实覆盖归一代码路径。

### 12.2 修复 B：纯侧边栏

- 顶栏（banner）不再渲染任何菜单项（nav-shell 断言 `banner menuitem count = 0`）；布局钉死 sidebar-nav。
- 侧边栏：pass2 规格保留（分组标签 11px/36px、叶子 32px/500、active 蓝左条+蓝字+浅灰底、hover 浅灰、8px 圆角）；底部左下折叠开关（Vben 内置）+ 右下帮助按钮（快捷键说明 Popover，pass3 新增，不涉路由）。
- 折叠态 tooltip 为 Vben 内置行为（collapse 时 title 进 tooltip）。

### 12.3 修复 C：交互

| 项 | 交付 | 说明 |
|---|---|---|
| C1 命令面板 | `command-palette.vue` + 顶栏触发按钮 | ⌘K/Ctrl+K；模糊搜索 accessMenus 全部页面 + 6 个静态动作（去发现买家/新建战役计划/查看买家线索/邀请成员/查看通知/回复收件箱，全部指向既有路由）；键盘 ↑↓/回车/Esc；内置 Vben GlobalSearch 已在 preferences 关闭避免双 ⌘K |
| C2 骨架屏 | AsyncSection/设置四页 | Spin/自绘 spinner → antd Skeleton；加载文案转 sr-only（innerText/读屏仍可用，既有断言不破） |
| C3 数字动效 | `use-count-up.ts` | rAF 缓动 600ms；companies/pending/following/team 四个数值项；tabular-nums；KPI 卡入场错峰淡入；**环比箭头跳过：现有 API 无上期数据** |
| C4 漏斗可点 | 已有 + hover 抬升 2px + 阴影 | 五阶段卡整体可点跳预筛列表（pass2 已接路由） |
| C5 hero 卡 | 工作台最上方大卡 | 建议一句话 + 主 CTA「立即处理」（品牌蓝全圆）+ 次链接（按主目标互补派生，既有路由）；原侧栏建议卡移除 |
| C6 完成反馈 | 行内「完成」按钮 | 划线动画 320ms → 归档（本机）→ 列表/「今日脉搏·待办」计数即时 -1 → antd message toast「已完成：…」；**无完成 API，完成=本机归档**（沿用 pass2 只读标注） |
| C7 行内快捷操作 | **跳过** | 列表行已有常显操作列（leads 卡片操作、companies 表格操作列）；hover 浮现会与触控/可发现性冲突，维持常显（有意偏离，非 API 缺失） |
| C8 chips 即时 | 已即时 + 激活 chip 可单独移除 | 移除=回到默认队列 needs_review；✕ 带 aria-label |
| C9 微交互 | CSS only | 主按钮 hover 上移 1px+阴影/active 下压；列表卡 hover 抬升 1px；页面切换 fade-slide（Vben 默认已启用，确认无需改动） |
| C10 空状态 | pass2 已统一 | 图标+标题+说明+主 CTA+次链接双路径，本轮无回归（zero-jargon/a11y 绿） |

### 12.4 功能守恒

- `api/`（除 user.ts:18 点名的一处色值）、`apps/server/**`、`packages/**`、`store/**`、`router/guard.ts`、`router/access.ts`、所有路由模块：零改动。
- 既有 locales key/value：零改动；新增 UI 文案（搜索或跳转/命令面板/动作名/完成/已完成/快捷键/帮助）为组件内按 `preferences.app.locale` 生成的双语字符串，未新增 locale key。
- 表单字段/校验/表格列/弹窗/权限点：未改。
- 有意展示差异仅：hero 卡替代侧栏建议卡、Spin→Skeleton、顶栏搜索按钮换成命令面板触发、侧栏右下帮助按钮、行动清单新增「完成」按钮。均记录于本节。

### 12.5 质量门与证据

- `pnpm typecheck / build / lint:terms / lint:date / e2e:nav`：见 PR（含新增 pass3-cache-normalize / pass3-color-scan / pass3-interactions 三个 spec 与 nav-shell 顶栏断言）。
- 颜色白名单（渲染 DOM，明暗两主题 + nprogress bar 显式断言 `rgb(51,92,255)`）：`pass3/color-scan.txt` — 11,259 样本，violations 0。
- 前后对比截图：`pass3/before-*.png`（= pass2 后）/ `after-*.png`（workspace、leads、settings/members，明暗各一套）。
- 盲测说明：自动化无法替代真人；PR 中列出 ≥5 处可感差异清单（命令面板、骨架屏、hero 卡、可点漏斗 hover、侧栏帮助/纯侧边栏、数字动效、完成反馈）供人工盲测核对。


---

## 13. Pass4 修复对零（2026-11-22）：SDR 侧栏对齐

### 13.1 问题与方案

用户实测：菜单栏未按 SDR 风格改造。根因有二：
1. Vben 菜单按「可折叠分组（手风琴）」渲染，多数菜单项默认收起，与 SDR「分组标签 + 全部可见」结构不符；
2. 主题/语言/搜索仍在顶栏，与 SDR「操作都在左侧栏」不符。

方案：新增 `components/gainos/sdr-sidebar.vue` 以 fixed 覆盖层渲染 SDR 原版结构（packages/ 禁改，无法替换 Vben 菜单插槽）；桌面隐藏 Vben 菜单（gainos.css，<768px 移动抽屉仍用 Vben 菜单）。

### 13.2 SDR 规格落地（Sidebar.tsx 逐项对照）

| SDR 规格 | 实现 | 量测（measurements.json） |
|---|---|---|
| 分组小标签 12px 灰 | `.sdr-section__label` 12px/500 subtle 灰 | titleFontSize 12px |
| 行 h-9(36px)/px-2(8px)/rounded-lg(8px)/500 | `.sdr-row` | height 36 / fontSize 14 / weight 500 / radius 8 |
| active = bg-bg-weak-50 + text-strong-950（灰底药丸+近黑字，无彩条） | `.sdr-row.is-active` | bg rgb(245,245,245) / color rgb(23,23,23) |
| hover = 同灰底 | `.sdr-row:hover` | — |
| 图标：active 实心近黑 / 非激活 soft 灰 | icon 颜色随状态 | — |
| 分组永远可见（无手风琴） | sections 拍平 accessMenus | 11 个 menuitem 全部直接可见 |
| Jump to 搜索框在侧栏顶部（h-9 ring-1 + ⌘K） | `.sdr-search` → 打开命令面板 | — |
| 折叠为图标窄栏 + tooltip | `.sdr-rail`（Vben 左下折叠按钮触发） | e2e 点通 |
| 品牌行右侧主题切换 | `sdr-brandtools`（aria-label dark/light 保持 e2e 兼容） | — |
| 顶栏无菜单、无主题/语言/搜索 | widget 缓存归一 + overlay | banner menuitem=0 |

### 13.3 缓存归一扩展

`BRAND_PREFERENCES` 新增 `widget.{themeToggle,languageToggle,globalSearch}=false`：老缓存里这些顶栏开关=true 会让顶栏重新长出主题/语言按钮（与侧栏重复）。

### 13.4 功能守恒

- 路由/api/server/packages/store/guard/access：零改动（新增组件 + CSS + preferences + 布局文件内 wiring）。
- 既有 locales key/value 零改动；侧栏标签/搜索文案经 `$t(menu.name)`（Vben wrapperMenus 同款，i18n key 或已译文本都正确）。
- 顶栏保留：侧栏开关、刷新、通知、用户菜单（通知/用户无侧栏承载位，保留为 SDR 页面级能力的等价物；SDR 本身无此二者，删除断功能不可接受）。
- 移动端抽屉仍用 Vben 菜单（<768px 覆盖层隐藏），active 已同步改为 SDR 灰底药丸。
- 有意展示差异仅：桌面侧栏菜单由覆盖层渲染、顶栏部件收窄、折叠态为图标窄栏。

### 13.5 测试与证据

- 规格迁移：nav-shell/settings-shell/main-chain/pass3-cache-normalize 的 `.vben-menu` 作用域 → `[data-sdr-nav]`；pass2-measure 断言改为 SDR 量测（36px/12px/灰底 active/8px 圆角）。
- 折叠窄栏 e2e 点通（图标导航 + 展开恢复）。
- 颜色：pass4 渲染扫描 13,946 样本 violations 0（含侧栏覆盖层）；源码 88 文件 0 违规。
- 截图：`pass4/sidebar-{light,dark}.png`、`sidebar-collapsed-light.png`、`after-{workspace,leads}-*.png`。

## 14. Pass5 修复对零（2026-11-22）：左下角操作区 + 顶部标签页

任务（用户原话要点）：参考 AgentSDR 把登录/设置/通知移到左下角；顶部改成标签页，
解决页面太多的问题；以 Awwwards/Webby/FWA 获奖级网站为标准自检优化。

### 14.1 布局变化（全部 preference/CSS 驱动，packages/ 零改动）

| 变化 | 实现 |
|---|---|
| 顶栏整体隐藏 | `preferences.header.hidden: true`（+ BRAND_PREFERENCES 缓存归一） |
| 顶部 = 标签栏 | `tabbar: {enable, showIcon, styleType:'card', height:40, showMaximize:false}`；40px 画布栏；`header.height: 40` 让侧栏品牌行与标签栏合成同一条顶部横带。Vben「内容最大化」会写 `header.hidden=false + sidebar.hidden=true`（翻出顶栏、只藏侧栏不藏 SDR 覆盖层）——该控件已移除，`sidebar.hidden:false` 进 BRAND 归一（救回被点坏的缓存）；SDR 覆盖层也尊重 `sidebar.hidden` |
| 标签风格 | 「反白选中」：当前页 = 30px 实心药丸（浅色主题近黑底白字 / 深色主题白底深字）+ 8px 圆角 + 13px/500，非当前页 = 纯 muted 文字（透明底），hover 浮出 5% 淡底——选中与未选中一眼可辨；关闭符仅 hover/当前页出现（不可见时 pointer-events:none 防误关），右侧恒留 26px 关闭槽位保证宽度稳定，无关闭符时收回 12px；长标题 180px 截断 |
| 标签条无滚动条 | 四路显式关闭：viewport `overflow:hidden`（reka 默认 `overflow:scroll`，Windows「始终显示滚动条」会把无溢出的空滚动条画出来，2026-11-23 线上实测）+ 原生/overlay 滚动条（`scrollbar-width:none` + `::-webkit-scrollbar`）+ Vben 自带 ScrollBar（按 `data-slot='scroll-area-scrollbar'` 强制 `display:none`——它原本只靠 tailwind `hidden` 类，dev 下类名扫描差异会漏生成，5666 实测露出过）+ 溢出时靠滚轮横向滚动、两端渐隐 mask 与左右小圆角滚动按钮 |
| 侧栏左下角操作区 | sdr-sidebar footer：分隔线 + 通知行（未读红点→/notifications）+ 设置行（打开设置弹窗，替代原「设置」导航分组）+ 帮助行（Popover：⌘K 快捷键 + 版本号） |
| 设置信息架构（SDR SettingsShell） | 侧栏不再列 成员与角色/禁联名单/数据源/数据与隐私/审计；底部「设置」打开 1080×780 浮层：左分区导航（accessMenus 同源、按权限过滤）+ 右侧真实页面（复用路由组件，Suspense 骨架）；Esc/遮罩/× 关闭，Tab 焦点圈定，背景路由变化自动关闭；直接访问 /settings/* 仍是整页（深链不变） |
| 工作空间账号卡 | 12px 圆角卡：头像/首字母兜底 + 空间名 + 账号 + ⋮；点开 = SDR Dropdown 同款面板（264px、16px 圆角、1px 描边、tooltip 阴影：抬头 名称/邮箱 → 分隔线 → 通知/设置/搜索或跳转(⌘K) → 分隔线 → 退出登录 红字红底 hover） |
| 设置弹窗遮罩 | SDR Modal Overlay 同款：暗化 32% + `backdrop-filter: blur(3px)`（深色 62%），弹层下内容真实模糊 |
| 品牌行三按钮 | 折叠（sidebar.collapsedButton=false 后 Vben 左下按钮关闭）、主题、语言；按钮 28px、右缘对齐侧栏 12px 内边距。侧栏可拖拽（Vben 允许 60–320px），布局层兜底**最小宽度 224px**（低于即拉回）——否则品牌行 logo 与工具按钮重叠（2026-11-23 用户实测） |
| 折叠 rail | 宽度 = collapseWidth(60px)；底部 = 展开按钮（panel-left-open）+ 账号头像（未读点 + 同款 Dropdown） |
| 移动端抽屉 | 顶栏隐藏殃及 Vben burger → `.sdr-mobile-burger`（标签栏左侧固定，代理 click 隐藏开关）；标签栏 padding-left 44px 让位 |
| 通知部件 | widget.notification=false（入口在侧栏底部行 + 账号菜单）；basic.vue 轮询保留供未读数 |

### 14.2 功能守恒

- 路由/api/server/packages/store/guard/access/locales key-value：零改动。
- 全局操作迁移等价表：顶栏主题/语言→品牌行（pass4 已做）；顶栏通知→侧栏底部行+账号菜单（未读数轮询同源）；顶栏用户菜单→账号卡 Dropdown（退出登录/设置等价）；顶栏刷新→标签栏右侧工具（Vben 自带）；帮助+版本→帮助行 Popover（pass4 overlay 等价迁移）。
- 设置：五个设置页的入口从侧栏分组迁到设置弹窗（SDR 同款），路由/权限/页面组件零改动；`/settings/*` 深链、命令面板与旧链接（/profile、/settings/workspaces）行为不变。
- 设置页内嵌时（设置弹窗中）不再读写 URL query（audit 筛选只存本地）——背景路由属于用户当前页面，避免污染；整页模式下 URL 同步保持原样（`SETTINGS_EMBEDDED_KEY` 注入，默认 false）。
- 删除的仅为死代码：basic.vue 通知槽位处理器（markRead/remove/handleMakeAll/viewAll/handleClick/navigateTo）、UserDropdown 槽位、版本号常量（功能分别由通知页自身/侧栏账号卡/帮助弹层承载）。
- 顶栏隐藏后 `<header>` 仍在 DOM（margin-top 滑出）；既有 spec 的 `banner menuitem=0` 断言继续成立。

### 14.3 视觉自检（获奖级标准逐项）

- 排版：标签 13px/500、-0.011em；栏内 40px 高、30px 卡、上下各 5px 呼吸；左右 12px 与侧栏节奏对齐；标签间 2px。
- 留白/层级：当前页白卡 + 微阴影浮于 `--gs-bg` 画布之上，非当前页只留文字——一眼可辨“我在哪、还能去哪”。
- 色彩：选中 = 反白实心药丸（#171717/白字，深色反转），未选中 = #5C5C5C muted 文字；品牌蓝只留给主行动与 focus 环。
- 动效：颜色/背景/阴影 150ms；按压 scale .985（120ms）；关闭符 140ms 淡入；标签溢出滚动由 Vben 以瞬移（非平滑）执行，避免长列表的拖影。
- 账号菜单：对齐 AlignUI Dropdown（rounded-2xl / p-2 / ring-1 / 36px 条目 / 18px 图标 / 全幅分隔线 / destructive 红字红底），条目含 ⌘K 提示与未读点。
- 中键关闭：按下只抑制浏览器中键自动滚动，**释放（auxclick）才关闭**（`tabbar.middleClickToClose=false` + basic.vue 文档级监听，按 `data-index` 定位页签；与浏览器标签一致）。
- 微交互：关闭符 hover 才出现且不可见时不可点；hover 淡底；工具按钮（更多/刷新/最大化）去掉竖分隔线改 30px 圆角热区，移动端 34px；focus-visible 品牌环。
- 响应式：移动端 burger 44×40 + 标签栏 padding-left 44px 无重叠（390px 实测）；标签长标题 180px 截断。
- 原创性：不做 Chrome 式“附着页签”，采用与侧栏 active 同语言的“白卡浮层”+ 恒留关闭槽位 + 按需出现关闭符，形成本产品自己的标签语言。

### 14.4 测试与证据

- 新 spec `pass5-shell.spec.ts`：标签页留痕/切换/关闭/active 样式、侧栏底部三行+账号卡+帮助弹层、设置弹窗开合（含账号菜单入口）、折叠 rail 宽度 60/展开入口、移动端 burger 开抽屉。
- `settings-shell.spec.ts` 重写为弹窗口径：五分区切换、审计页控件、背景 URL 不变、Esc 关闭、深链仍是整页。
- 既有 spec 适配：nav-shell/main-chain 的「设置」分组点击删除（扁平导航叶子常驻），组标签断言收窄 `.sdr-section__label`。
- 回归全绿：nav-shell 2、settings-shell、main-chain 9、pass3-cache-normalize、locale-toggle、pass3-interactions、pass2-measure、dark-mode、responsive（desktop/dark/mobile 三 project）。
- 截图：`pass5/{light,dark}-{workspace,tabs-many}.png`、`light-command-palette.png`、`light-tabs-overflow.png`（1100px 溢出态：无滚动条、两端滚动钮）、`light-tab-hover/tool-hover/help-popover/rail/rail-account-menu.png`、`{light,dark}-account-menu.png`、`dark-tab-hover.png`、`mobile-{workspace,drawer}.png`、`dialog-{members,sources}-light.png`、`dialog-{members,audit}-dark.png`（18 张）。

## 15. Pass6 批次 1（2026-11-23）：Ant Design 基线 + 买家线索样板页

方案 B（全站 AntDV 化）的第 1 批：地基 + 样板页，其余页面按批次 2/3 推进。

### 15.1 地基
- 设计规范：新增 `docs/engineering/ui-design-system.md`（字阶 12/13/14/16/20、间距 4–32、圆角 10、表格/表单/反馈/动效规则）。
- 主题 token：`Modal/Drawer` 圆角 20→10；新增 `fontSizeSM:12`、`motionDurationMid:0.15s`、`Card.paddingLG:24`、`Table.fontSize:13`、`Tag/Alert/Notification` 圆角；删除 `gainos.css` 里 `.ant-btn-primary{9999px}` 与 hover 位移/发光覆盖。
- 反馈层：新增 `apps/web/src/feedback.ts` + `components/feedback-init.vue`（`App.useApp()` 上下文），替换 `api/request.ts`、`router/access.ts`、`store/auth.ts`、`workspace`、`onboarding` 的静态 `message/notification`；`window.confirm` 全部改为 `feedback.confirm`（runs / members / suppressions / companies×4 / find-buyers，共 8 处，ops 除外）。
- 封装层：`components/gainos/ui/` 九个薄封装（GsPage/GsCard/GsTable/GsEmpty/GsModal/GsTag/GsStat/GsToolbar/GsSelect）；GsSelect 修补 antdv 4.2.6 的 combobox ARIA 缺口（aria-expanded + 关闭态移除无效 aria-controls/owns/activedescendant），a11y 门禁不减项。
- ErrorNotice 改为 `a-alert` 承载，保留三层文案、`role="alert"` 与 `.error-notice__details` 折叠。

### 15.2 样板页：买家线索（`views/leads/index.vue`）
- 模板全部换 antd：GsPage + a-steps + GsToolbar(a-radio-group/a-input) + a-alert + a-skeleton + GsEmpty + GsCard 列表 + a-modal 裁决/提商机；页面 scoped CSS 从 225 行降为 **0 行**。
- 锚点：`data-gs="page-header|stage-steps|queue-toolbar|queue-switch|lead-search|sanctions-banner|lead-card|lead-accept|lead-reject|load-more|decision-modal|promote-modal"`；旧 `.ld__*` 全部移除。
- 成功提示改 `feedback.message.success`（接受/拒绝/提升），裁决弹层 `okType=danger`（拒绝）。

### 15.3 测试与证据
- 迁移：nav-shell（leads landmark）、main-chain（卡片/按钮锚点 + antd 确认框交互）、idempotency（卡片锚点）、a11y（卡片锚点）、pass2-measure（leads 段改 token 符合度：按钮 10px/32px、卡片 10px + 阴影）。
- 本地全绿：typecheck/build、a11y、color-scan（pass2/pass3）、dark-mode、responsive、21 个定向 spec。
- 证据：`docs/evidence/ui-restyle/antd-system/{leads,leads-modal}-{light,dark}.png`。

## 16. 买家线索判定可读化（2026-11-23）

用户反馈：线索页把引擎的聚合文本（`judge-aggregate/v1`、`C1_MATERIAL pass（score 8）`、`reasonCodes=…`）直接展示，普通用户看不懂。本次把 C1–C5 解析成业务维度，列表按参考图重排，详情加五维雷达。

### 16.1 解析与文案
- 新增 `views/leads/judge.ts`：`parseJudge()` 解析五维（兼容字符串/数组/JSON 字符串/对象）、结论码、加权说明；`keyDimension()` 选决定性维度；`shortRationale()` 截断；`scoreGrade()` 分档。
- 新增 `views/leads/judge-labels.ts`：维度名（产品品类/买家角色/生产工艺/经营模式/企业规模）、判据状态词表、`ICP`→「目标客户画像」的展示替换。
- i18n（zh/en 同步）：`leads.scoreLabel/scoreGrade/criteria*/dimScore/expand/collapse/moreActions/copyDomain/radar*/tech*/evidenceHighlight`，既有 key 未改。

### 16.2 列表（`views/leads/lead-card.vue`，从页面抽出）
- 卡片五行：公司（首字母牌位 + 国家/域名 + 行业/规模标签）→ 评分（分数 + 高价值/潜力客户/待观察）→ 判断结果+原因（决定性维度一句话，最多 2 行）→ 五维摘要（✓/✗/? + 结论 + 0–10 分）→ 操作（值得跟进/暂不跟进/⋯）。
- 待我判断的卡片左侧 3px 强调条；展开区显示逐维理由与「技术详情」（聚合原文/verdict/reasonCodes/加权说明）。
- 页面 scoped CSS 仍为 **0 行**（样式随卡片下沉到组件）。

### 16.3 详情（`views/leads/detail.vue`）
- 整页迁 AntDV：GsPage + a-tabs（档案/决策人/触达草稿/结果）+ GsCard + a-descriptions + a-modal（裁决/提商机）。
- 档案页首屏：判断结果 hero（46 + 高价值/待观察 + 1 项符合·3 项不符·1 项证据不足 + 关键理由 + 核心证据）+ 五维雷达（新增 `components/gainos/ui/gs-radar.vue`，纯 SVG、无新依赖、双主题）。
- 逐维明细：状态图标 + 名称 + 结论 + 0–10 分条 + 理由（新增共享组件 `views/leads/judge-dimensions.vue`）；八维 `scores` 保留为「评分维度」补充卡。
- 证据不足的维度按 0 绘制，图下注明；机器码与聚合原文只进折叠区。

### 16.4 验证与证据
- 新增 `e2e/leads-judge.spec.ts`：用用户给出的真实形状数据锁定「列表/详情不出现 C1_MATERIAL / judge-aggregate / reasonCodes / ICP」「展开可见逐维理由」「技术详情内可见机器码」「详情雷达 role=img」。
- 回归：nav-shell、main-chain（9 条）、idempotency、a11y、resilience、pass2-measure（按钮 40px）、color-scan（pass2/pass3）、dark-mode、responsive、locale-toggle、zero-jargon 全绿；`resilience` 的旧 `.ld__lead` 锚点改 `data-gs="lead-card"`。
- 证据：`docs/evidence/ui-restyle/antd-system/leads-judge-{light,dark}.png`、`leads-detail-judge-{light,dark}.png`。

### 16.5 边距回归修复（2026-11-23）
用户验收反馈「页面没有边距」。根因不在页面 padding，而在批次 1 的封装层：`GsCard/GsTag/GsEmpty/GsModal/GsTable/GsStat` 使用了 `<a-card>`/`<a-tag>` 字符串标签，但本应用从未全局注册 AntDV → 浏览器把它们当自定义元素 `A-CARD` 渲染，`body-style` 变成 `[object Object]` 属性，卡片 body padding=0、card head/title 与作用域插槽全部丢失，Tag 退化为纯文本。
- 修复：六个封装改为显式 `import { Card, Tag, Empty, Modal, Table, Statistic }` 并使用 PascalCase 组件；`GsCard` body padding 24px；`GsEmpty` 的操作区移到 Empty 下方（不再占用 image 槽）；卡片标题包 `role="heading" aria-level="2"`。
- 页面留白：列表/详情根容器改用 `--gs-page-max`（1280）与 `--gs-page-pad`（桌面 32px），卡片与页面边缘都有可见留白。
- 验证：typecheck / lint 全绿；定向 e2e 34 项全绿（含 color-scan ×2、a11y、dark、responsive、zero-jargon、main-chain、leads-judge）；证据重拍 `antd-system/leads-*`、`pass2/*`、`pass3/*`。

## 17. 买家线索页对标商业名录页（2026-11-24）

用户第二次给出参考图并要求「弄成这种效果」。§16 的信息结构保留（C1–C5 解析、机器码只进技术详情），这一轮改的是观感。

### 17.1 页头与画布
- `GsPage` 默认改为渐变页头：通栏品牌蓝极浅渐变带 + 内联 SVG 插画，H1 28/600；`:hero="false"` 回到素净页头。
- 步骤条装进白色薄面板（`GsCard dense`）并上移压进渐变；列表页根容器去掉顶部内边距，页头通栏贴顶。
- 画布 `--background-deep` 由纯灰 `0 0% 95%` 改为近白微蓝 `220 30% 97.6%`（全站生效）；暗色侧栏补上中性灰覆盖 `.dark .dark { --sidebar: 0 0% 12% }`。

### 17.2 队列页签与工具栏
- 新增 `components/gainos/ui/gs-segmented.vue`（药丸页签，`role=group` + `aria-pressed`），替换 `RadioGroup button-style=solid`；原「×」清除按钮随之移除（点「待我判断」即可回到默认队列）。
- 目标客户画像下拉、搜索（带放大镜前缀）、商机、刷新并入 `GsToolbar`；页头不再放操作按钮。

### 17.3 线索卡
- 去掉线边框与竖向分隔线，改「环 + 柔和投影」白卡；操作按钮改为一行（跟进 / 排除 / ⋯），垂直居中。
- 判断结果由队列名改为机器结论药丸；原因压成一行；维度计数摘要移入展开区。
- 新增 i18n：`leads.cardAccept`（跟进）、`leads.cardReject`（排除）、`leads.verdict.{match,weak,mismatch,unknown}`。既有 key/value 未改。
- 断点：视口 ≥ 1512px 五列并排，以下四列 + 维度横排，手机单列。

### 17.4 取色扫描夹具缺陷（顺带修复）
- `pass2/pass3-color-scan` 的属性名写成了驼峰（`backgroundColor` 等），`getPropertyValue` 对标准属性只认短横线名 → 背景色与边框色**从未被采样**。
- 修复为短横线名后样本量 21,416 → 84,086；暴露出两个此前不可见的问题并一并处理：
  1. `outline-style:none` 的元素仍会报一个 oklab 的默认 `outline-color`（10,007 个假阳性）→ 没画出来的描边不采样；
  2. 暗色侧栏是 Vben 自带的带蓝调 `rgb(28,30,35)`（不在色板内）→ 换成同明度纯中性灰。
- 修复后全站 15 页 × 明暗两套未知色相 0；新画布色被采到并归为品牌色系。

### 17.5 踩坑记录
- Tailwind 工具类挂在 antd 根节点上不生效（cascade layer）：步骤面板的 `-mt-12` 被 `.ant-card{margin:0}` 吃掉、带前缀的搜索框被 `.ant-input-affix-wrapper{width:100%}` 撑满导致工具栏折成三行。改为包一层普通 div。

### 17.6 验证与证据
- typecheck / build / lint:terms / lint:date 全绿；定向 e2e 43 项全绿（a11y、取色扫描 ×2、dark-mode、responsive、zero-jargon、locale-toggle、main-chain 9 条、leads-judge、leads-detail、idempotency、resilience、nav-shell、error-copy、interactions ×2、cache-normalize、pass5-shell）。
- 注意：本机用 8 个 worker 并发跑会把机器压满，pass2-measure / pass5-shell 会出现超时假失败；单独跑或 `--workers=4` 均通过。
- 证据：`docs/evidence/ui-restyle/antd-system/leads-judge-wide-{light,dark}.png`（1586px，五列）、`leads-judge-{light,dark}.png`（1440px，含展开区）、`leads-detail-judge-{light,dark}.png`。

## 18. 验收反馈两处修正（2026-11-25）

### 18.1 步骤条的「5」
- 用户：「去掉这个数字 5，用户不知道什么意思。」
- 当前步改为「蓝底圆 + 白点」标记，不再显示序号；`leads-judge.spec` 断言步骤图标里没有数字。

### 18.2 「⋯」按钮点击无反应
- 根因：`Dropdown` 按 React 版 antd 的写法传了 `:menu`，而 antdv 4 只认 `overlay` / `#overlay`。弹层被打开但内容为空（36×0），所以看起来毫无反应。
- 这是 §16 就引入的缺陷，e2e 从未点击过该按钮，直到用户手点才暴露。
- 修复：`#overlay` + `<Menu :items="menuItems" @click="onMenu" />`。
- 补测：`leads-judge.spec` 点击「⋯」→ 断言菜单可见且恰为「查看档案包 / 复制官网域名」→ 复制后有提示且剪贴板内容正确 → 「查看档案包」跳转到详情页。
- 该按钮的用途：收纳两个次要动作（打开档案包、复制官网域名），主动作「跟进 / 排除」已经在卡片上。

### 18.3 验证
- typecheck / build / lint:terms / lint:date 全绿；定向 e2e 34 项全绿（含 a11y、取色扫描 ×2：84,102 个样本、未知色相 0）。

## 19. 决策人列表重排（2026-11-25）

用户要求：线索档案包的决策人列表也改排版，提高可读性；本轮不跑 e2e，正式上线前统一跑。

### 19.1 改动
- `views/leads/DecisionMakerCard.vue` 重写：原生按钮 / 自制遮罩弹层 / 手写提示全部换成 antd（Button、Modal、Alert、Checkbox、Skeleton、Tag）+ `GsCard` / `GsEmpty` / `GsTag` / `ErrorNotice`；scoped CSS 从约 80 条规则收敛为卡片三列网格与少量排版。
- 排版：页头（标题 + 说明 + 操作）落在画布上；每位决策人一张浮起白卡，三列对齐（人 / 联系方式 / 来源）；联系方式行的类型标签等宽、状态药丸与「验证邮箱」上下成列。
- 状态文案新增 `contacts.badge.*`（已验证 / 待确认 / 推断 / 已拦截 / 无效 / 未验证），不再显示括号里的引擎枚举；既有 `contacts.status.*` 未改。验证完成的提示也改用这组词。
- 来源去重：同层级已有带链接来源时，不再显示同层级不带链接的重复行（不同链接全部保留）。
- `GsCard` 新增 `padding` 属性；`detail.vue` 的「决策人」页签去掉多套的一层卡片。
- 提示条区分语气：验证被拦截 / 验证结果非「已验证」为警告色，其余为成功色。

### 19.2 验证范围（本轮未跑 e2e）
- 已做：typecheck、build、lint:terms、lint:date；用模拟数据截图确认列表 / 空态 / 错误态 / 验证弹层（明暗两套），控制台无报错。
- 未做：e2e 套件、a11y（axe）与取色扫描——这张卡片目前没有任何自动化用例覆盖，a11y 审计的页面清单里也不含详情页的「决策人」页签。正式上线前跑全量时建议把该页签补进 a11y 审计清单。

## 20. 找买家页对标买家线索页（2026-11-25）

用户要求：按买家线索页的风格和理念优化找买家页。本轮按约定不跑 e2e，正式上线前统一跑。

### 20.1 列表
- `views/find-buyers/icp-card.vue`（新）：画像卡五列（画像 / 目标市场 / 寻源方案 / 最近寻源 / 操作），与线索卡同一套卡片语言。
- 「寻源方案 / 最近寻源」进入页面时按画像并行预取（每个画像 2 个请求），不阻塞列表；取不到显示「—」，确实没有才显示「还没有」。
- 页头（`GsPage`）、步骤面板、工具栏（`GsToolbar`）与线索页一致；加载用骨架屏，空态 / 错误态用统一组件。
- 原模板里写死的中文「N 条资格规则 · N 个买家画像」改为文案键。

### 20.2 详情
- 原来的 920px 手写大弹层改为 antd `Drawer`，正文按卡片分区：画像概览 / 反馈建议 / 寻源方案 / 最近寻源 / 高级（规则与回测，默认收起）。
- 新建 / 编辑 / 规则改为 antd `Modal`；9 处页面内固定提示条改为统一反馈层。
- 业务逻辑（规则、回测、方案、发起寻源、本机运行记录、企业事实检查）逐字保留：脚本从旧文件原样截取，只对取值归一、提示方式、列表预取做了逐处断言的替换。

### 20.3 顺带修掉的旧问题
- 规则弹层的「规则类型 / 比较方式」标签一直显示的是文案键名（`gainos.findBuyers.ruleKind`）——该键在文案表里是选项映射而不是字符串。新增两个标签键。
- 公司属性字段名（技术与工艺、区域…）写死在代码里，英文界面也显示中文。改为 13 个文案键。
- 步骤条：当前步之后的步骤仍显示序号（「4 等待寻源」「5 判断线索」），与用户此前指出的「5」是同一个困惑；改为空心圆。antd 还把每一步渲染成点击无效的「按钮」，已去掉。
- 新建时公司选项带着原始状态枚举（如 `ACTIVE`）；公司状态没有业务词表，改为只显示名称。
- 卡片断点初设 1279px，实测五列最少需要约 1070px 内容宽度，1280–1407px 会溢出，已调到 1407px。

### 20.4 共用组件
- 新增 `components/gainos/ui/gs-steps.vue`，买家线索页与找买家页共用（线索页内联的步骤逻辑随之移除）。

### 20.5 验证范围（未跑 e2e）
- 已做：typecheck、build、lint:terms、lint:date；用模拟数据截图确认列表（1586 / 1280 / 390）、详情抽屉、新建 / 编辑 / 规则弹层、空态、暗色；手机宽度无横向溢出；控制台无报错；买家线索页步骤条无回归（无数字、无假按钮）。
- 用例锚点：`nav-shell` 的页面锚点由 `.fb` 改为 `[data-gs="page-header"]`。其余依赖本页的用例只用按钮名称（查看与调整 / 生成寻源方案 / 确认方案 / 开始寻源），这些名称未变。
- 未做：e2e 套件、a11y、取色扫描。

## 21. 响应式：手机导航与平板布局（2026-11-25）

用户反馈：手机上菜单还是旧的，没有通知 / 设置 / 退出登录；平板上功能页右侧的信息显示不出来。

### 21.1 手机导航
- 原因：新版侧栏是只在桌面宽度下渲染的固定覆盖层，手机抽屉里露出的是 Vben 自带菜单——没有底部账号区（顶栏隐藏后退出登录也没有入口），菜单项还是浅色字落在白底上，除当前项外全部不可见。
- 处理：侧栏拆成「导航数据（`use-sdr-nav.ts`）+ 内容面板（`sdr-nav-panel.vue`）+ 容器（`sdr-sidebar.vue`）」；手机改为 antd `Drawer`（300px / 84vw），与桌面共用同一份内容和底部账号区，品牌行增加主题 / 语言 / 关闭。汉堡按钮直接打开它，不再代理点击 Vben 的开关。
- 抽屉在路由跳转后自动收起；设置 / 搜索类动作先收抽屉再打开对应弹层。

### 21.2 平板布局
- 量到的事实（内容区宽度 544 / 596 / 800px）：买家线索横向溢出 330px，找买家 161px，线索详情「决策人」页签 46px，被内容区的 `overflow-x: hidden` 裁掉。其它页面不溢出。
- 根因两个：① 页面根是网格但没有约束列宽，子内容一宽就把整列撑开，步骤条、工具栏跟着被撑出屏幕；② 卡片的断点按视口宽度设，没有减去侧栏占掉的 224px。
- 处理：
  - 页面根统一 `grid-cols-1 @container`；线索卡、画像卡、决策人卡、详情页网格改为按内容区宽度分级（容器查询），窄屏优先。
  - 步骤条自己量容器，窄于 760px 竖排（antd 自带的只看视口，侧栏占位时判断不准）。
  - 工具栏在窄内容区下两两成行。
  - 平板竖屏（768–1023px）侧栏自动收成图标窄栏：820px 宽的平板内容区从 596px 增加到 760px。自动收起会在本地留标记并在离开该宽度时恢复，不覆盖用户的真实偏好。
- 雷达图限定最大宽度 420px 并居中（单列堆叠时原先会拉满整张卡片）。

### 21.3 验证
- 全部 21 个路由在 768 / 820 / 1024px 下逐一测量：内容区横向溢出均为 0（首轮测量因等待时间不足量到的是空页面，作废后重测）。
- 线索列表、线索详情、决策人页签、找买家在 390 / 768 / 820 / 1024 / 1280 / 1440 / 1586px 下截图检查，明暗两套。
- 侧栏偏好：平板自动收起 → 刷新仍收起 → 回到桌面宽度恢复展开；平板宽度下刷新后再回到桌面宽度同样恢复。
- 桌面宽度（1440 / 1586）的卡片布局与改动前一致。
- 用例：`responsive.spec.ts` 新增 tablet 项目并改为同时测量内容区溢出；`pass5-shell` 的移动端导航用例改为断言新抽屉。这两个文件本轮各跑过一次（手机 + 平板两个项目），通过。其余 e2e 未跑，留到上线前。

## 22. 公司档案：主档案与关联公司（2026-11-25）

用户反馈：注册完只有一家公司，但「公司档案」可以随便建好几家，用起来莫名其妙；正常逻辑应只维护注册时填写的公司。

### 22.1 分析结论
- 引擎/PRD 明确允许一空间多档案（集团/多品牌），这份设计本身没错；缺的是产品层的「主档案」概念与操作引导。
- BFF 已记录 `Workspace.onboardingCompanyId`（注册公司），但前端从未使用，页面把所有档案平铺成一张表格、「建立档案」还是页头主 CTA。

### 22.2 改动
- `views/companies/index.vue` 重构页面信息架构：
  - 主档案卡（注册公司徽标、状态、官网/行业/市场、4 项 KPI、唯一「下一步」、画像摘要）；
  - 关联公司区（仅多档案时出现）；「添加关联公司」先弹说明；
  - 建档 / 编辑 / 添加说明改 antd `Modal`；
  - 企业事实、资料库改为**页内工作台**（当前档案选择器 + 刷新 + 事实/资料库分段）：事实左侧概览/冲突、右侧清单，
    资料库左侧文件、右侧检索；KPI 与页脚入口滚动定位到工作台，不再用弹窗打断；
  - 旧表格、搜索筛选、手写弹层壳移除；事实审批、资料库、冲突、市场候选等业务逻辑原样保留。
- `components/gainos/ui/gs-page.vue`：页头插画按页面区分（买家线索靶心/点阵、找买家地球/同心圆、公司档案楼宇/网格），
  公司档案页不再因页头操作按钮而缺少插画（刷新/添加关联移到主档案页脚）。
- `views/find-buyers/index.vue`：设定画像时主档案排第一并标注「（注册公司）」。
- i18n 本轮再新增 11 个键（zh/en，累计 35 个），既有 key 未改。

### 22.3 验证（本轮未跑 e2e，按用户要求）
- typecheck / build / lint:terms / lint:date 全绿。
- 5666 生产构建预览已更新到本次构建（`index-Dz8k8Jcm.js`），`/companies` 200。
- 用模拟数据截图核对：主档案 + 关联公司（1586 / 1024 / 390）、页内事实工作台、资料库工作台、切换关联公司后的
  「返回主档案」、编辑弹层、添加关联公司说明、暗色；三个页面页头插画/底纹可区分；移动端加载后不自动滚动（scrollY=0）、
  横向溢出 0；控制台无报错。
- 定向 e2e 已补：`companies-profile`（主档案/关联公司/页内工作台/资料库/KPI 入口）、`main-chain` 事实审批、
  `market-candidates-read` 的恢复入口与迟到响应/轮询清理、`nav-shell` 公司档案页头、a11y `/companies`（含工作台）、
  responsive 手机与平板、pass2/pass3 取色扫描（公司页空态改用 antd simple 图，避免默认插画的硬编码灰与渐变）；
  全量 e2e 由 PR CI 复核。
- 未做：真实数据后端到端走查（本期未改 API/引擎，仅前端页面结构）。

## 23. 档案概览整段展示（2026-11-25）

用户反馈：档案概览下面明明有空间，却没有展示全。

### 23.1 原因
- 公司简介还留着弹窗时代的 `max-height: 4.8em; overflow: auto`，被截成不到 5 行并自带滚动条；「产品与服务」展开后的列表同样有 120px 内滚动。

### 23.2 改动
- `views/companies/index.vue`：简介整段展示；行业、目标市场、官网、业务邮箱改为标签对照（`dl`），目标市场用标签；产品与服务展开后不再内滚动；
  数量统计改浅灰块；没有简介也没有关键信息时不留空灰框。
- 宽屏两栏（内容区 ≥ 900px）且产品服务 ≤ 12 条时默认展开，窄屏默认收起。
- DOM 顺序改为「审批清单 → 概览/冲突」：窄屏先看到要处理的事实，宽屏用 `grid-area` 把概览放回左侧。
- i18n 新增 `companies.overviewWebsite`（zh/en）。事实清单保留 540px 内滚动（要和批量操作栏同屏）。

### 23.3 验证
- typecheck / build / lint:terms / lint:date 绿；定向 e2e（`companies-profile`、`nav-shell`、`main-chain` 事实审批、a11y `/companies`、
  responsive 手机与平板、`market-candidates-read` 的 V01/V01b）通过。
- 模拟数据截图：1586 / 1920 / 820 / 390、暗色、超长简介、30 条产品服务、草稿档案、带冲突；整块工作台只剩事实清单一个内滚动区。
- pass2 / pass3 取色扫描通过。未做：全量 e2e（由 PR CI 复核）；真实数据下的效果由用户在 5666 验收。

## 24. 线索档案包「决策人」改为「联系人」（2026-11-25）

- 改动：`leads.tab.people`、`leads.peopleAdminOnly` 与 `contacts.*`（title / emptyTitle / scopeHint / discoverOnceHint / missingEmail /
  discoverTitle / guessDesc / discoverDone），中文 10 处、英文 9 处。这些键只被线索档案包使用，其余页面不受影响。
  路由参数 `?tab=people`、组件名 `DecisionMakerCard` 不变；`leads-detail` 用例的页签断言与设计系统 §13 同步。
- 合并 #203 后，其新增的查邮验真文案（`contacts.enrichDesc / enrichDone / enrichNoContacts`，英文含 `enrichTitle`）在同一个页签里，一并改为「联系人」。
- 未改：线索列表卡片的 `leads.channelDecisionMakers`（「{count} 位决策人」）在买家线索列表而非档案包，不在本次范围内。
- 未做：`packages/shared/src/errors.ts` 里 BFF 返回的错误文案 `CONTACT_DISCOVERY_LAWFUL_BASIS_REQUIRED` 仍写「发现决策人前需要先声明合法性依据」。
  改它要动共享包和服务端构建，按「不动 packages / server」的约束未改。

## 25. 迭代画像后可重新发起寻源（2026-11-25）

用户反馈：编辑画像（版本号迭代）后没法发起新的寻源任务。

### 25.1 原因
- 前端「生成寻源方案」只在没有方案时显示；已执行的方案只有「查看运行」；任务页与运行页的「重试」只对失败 / 部分完成 / 已取消开放。
- 方案是生成那一刻的快照，画像改了却不重新生成，搜索条件仍是旧的。
- 引擎与 BFF 本身支持：同一画像可有多份方案；`EXECUTED` 计划带新 `attemptId` 可重跑；生产环境 attemptId 透传开关已开。这是纯前端缺口。

### 25.2 改动（`views/find-buyers/index.vue` + i18n）
- 画像生效中随时可生成方案，已有方案时文案为「重新生成寻源方案」。
- 已执行方案卡增加「再跑一次」，复用原 `executePlan`（任务 → `POST /tasks/:taskId/runs`，带新 attemptId）。
- 该任务有未到终态的运行时，「开始寻源」「再跑一次」置灰并提示；重新生成不受影响。
- 保存画像后若已有方案，方案卡顶部提示「画像已更新到第 N 版…重新生成后才会按新画像搜索」，重新生成后消失。
- i18n 新增 `findBuyers.regeneratePlan / rerunPlan / runInProgress / planStaleAfterEdit`（zh/en）。

### 25.3 验证
- 新增 `main-chain` 3b（编辑画像 → 提示 → 重新生成 → 确认 → 旧方案再跑一次并校验请求体）、3c（运行中不重复发起）。
- 主链路与档案包 12 条、a11y 9 条、responsive 2 条、dark-mode 1 条通过；模拟数据截图（改动前 / 编辑后 / 重新生成后 / 暗色 / 手机）。
- 合并主分支后复跑上述用例全部通过；pass2 / pass3 取色扫描、零术语扫描通过。未做：全量 e2e（由 PR CI 复核）；真实环境下的重跑未验证。

### 25.4 搁置项
- 编辑已完成档案的行业 / 目标市场 / 官网、已完成档案重新理解、同一张画像原地升版：引擎当前只允许 DRAFT 编辑与启动理解，
  重新生成画像永远是新建一张，需要改引擎。用户决定先不做。

## 26. 体验问题第一轮：11 项前端缺陷修复（2026-11-26，#1/#2 移交 onboarding 专项 PR）

用户实测整理出 27 个体验问题。涉及「商机与触达」的和需要改引擎的不在本轮；原 `#1/#2` 涉及注册引导页，
为避免与并行 `feat/onboarding-intake-combine` PR 冲突，已移交对方一并收口；这里记录本 PR 落盘的 11 项和 1 条建议，
编号沿用反馈清单。

### 26.1 全局与注册引导
- **#11 回车、方向键被吞**：命令面板的键盘监听挂在 `window` 上、随布局常驻，面板关闭时仍然对回车和上下方向键
  `preventDefault`，全站的多行输入框无法换行、光标不能上下移动。`command-palette.vue` 在面板关闭时直接放行。
- **#1 / #2（已移交）**：注册引导返回修改官网与行业选项去分类码移交并行 `feat/onboarding-intake-combine` PR 一并收口。

### 26.2 公司档案
- **#3 页签数量**：「企业事实 / 资料库」分段视图不再带计数。「企业事实 0」会被读成「没有事实」，那个 0 其实是待确认数；
  各状态的数量仍在清单自己的页签上（待确认 / 已通过 / 未采用）。
- **#6 生成事实草稿**：结果改用轻提示（有新增、没有新增各一句），清单与概览原地刷新，不再整块先变空再回来；
  审批、撤销、手动新增后的刷新同样不进加载态。「没有新增」改为「档案里的产品、行业和市场都已经生成过事实，本次没有新增。」
- **建议 2**：事实都审完、画像还没建时，主档案不再显示「下一步」标签和一段说明，只留「档案已就绪」和
  「设定目标客户画像」按钮（`data-gs="next-step"`）。

### 26.3 步骤条（#14）
- 原因：买家线索页把当前步写死为 5，找买家写死为 3（有生效画像时），和真实进度无关。
- 改动：新增 `apps/web/src/utils/acquisition-step.ts` 统一判定（规则见设计系统 §12.1），两页共用。买家线索页把一个画像下
  多个任务的运行记录合并后取最近一次；画像和进度都到手之前步骤条停在原位，不在加载时来回跳。

### 26.4 运行页（#15、#18）
- **#15**：页头的「目标客户画像 xxxx · 方案 xxxx · 任务 xxxx」移入折叠的「技术详情：任务编号」，给反馈问题时对账用。
- **#18**：五张进度卡原先拿引擎的阶段标记（`fit` / `enrich`）去比用户步骤（`match` / …），永远比不上，所以全是「等待开始」；
  完成与否又只认旧版统计字段（新格式 run 不再回填）。现在按 `run.phases` 判定，数字取 `stats.quickScan / stats.deep`；
  没有阶段标记的旧记录退回「第一个没走过的步骤是当前步骤」。没有数字时显示「已完成 / 进行中 / 等待开始」，五条步骤说明重写。
- 限制：引擎的快扫阶段内部不再细分，所以快扫一开始就算「搜索企业」「收集核实」已走过，由「匹配判断」代表快扫进度。

### 26.5 通知（#16、#17）
- **#16**：侧栏红点是布局里另一份 30 秒轮询的数据。工作台已读后会广播事件让它刷新，通知页没有；现在通知页已读、
  全部已读后同样广播。布局在轮询进行中收到刷新请求时，改为等这次请求回来后补刷一次，不再丢弃；通知页只有服务端确认
  已读的才在本地划掉。
- **#17**：没有可跳转链接的通知（如「一条企业事实已被撤销」）原先归为「建议」并配「去处理」，点了没反应。
  现在标为「通知」，不给「去处理」；有链接的照旧。

### 26.6 线索（#23、#26）
- **#23 复制没反应**：`navigator.clipboard` 只在安全来源下存在，用内网 IP 或 http:// 打开时是 `undefined`，
  点「复制官网域名」直接抛错并被静默吞掉。新增 `apps/web/src/utils/clipboard.ts`（不可用时退回隐藏文本框加
  `execCommand('copy')`，仍失败则抛错）；线索页和成员邀请链接改用它，失败时提示「复制失败，请手动选中文字复制」。
- **#26**：「查看档案包」从 ⋯ 移到卡片上成为可见按钮（`data-gs="lead-package"`），⋯ 里只留「复制官网域名」；
  操作列最窄按两个判断按钮算，放不下时按钮换行。

### 26.7 报错文案（#21）
- 原因：服务端没给三层文案时（网关 502、断网、超时、引擎透传的裸报错），页面报错块和右上角的全局提示会把
  `Request failed with status code 502` 这类英文原文直接摆出来。
- 改动：新增 `apps/web/src/api/failure-copy.ts`。服务端写了本语言的说明就用；否则按状态码给说明（`gainos.errors.*`，
  5xx 带状态码），英文原文只进「技术详情」。`failureText` 的兜底分支和全局提示改用它，各页面的调用点不用动。
  联系人卡片里靠标题含「授权对接」决定是否显示管理员说明的逻辑，改为标题和技术详情都看，换语言后不丢。
- i18n：新增 25 个键（`errors.*` 20 个、`common.copyFailed`、`workspace.cockpitAlertNotice`、`runs.userStage.done` /
  `inProgress`、`runs.techIdentity`），改 6 条既有文案（`companies.synthesizeDraftsNone` 与
  五条步骤说明），不触碰 `onboarding` 块，没有删除；zh / en 键集一致。

### 26.8 验证
- typecheck / Vitest / build / lint:terms / lint:date / check-legacy-redirects 绿。
- 新增 `ux-round-1` 8 条（按编号命名，断言只挂 role、文案和 `data-gs` 锚点；`#1/#2` 移交 `acq-p2-fast-onboarding-and-streaming.spec.ts`）；`leads-judge` 的 ⋯ 菜单断言同步；
  `release-prerequisites` 的编号断言改为「页头没有、技术详情里有」，并让它兼容带 /api 前缀的本地构建。
- 全量 e2e 606 条在本机分 4 片跑过（本轮改到报错文案、通知、布局这些全站共用的部分，受影响的套件接近全量）：
  首轮 597 过、1 条真栈冒烟按默认跳过、8 条失败。8 条均已定位——5 条是加锚点前后的新旧用例错位（页面状态本身正确），
  用最终构建复跑通过；2 条导航用例依赖已隐藏的「商机与触达」入口（上一轮隐藏时没同步），改为跟随开关；1 条标签页用例
  固定等待 600ms，实测本机加载完成后还要 0.7–0.8 秒才登记标签，改为按数量等待。最终构建上相关 12 个套件共 40 条通过。
- 测试会重新生成 `docs/evidence/ui-restyle/` 下的截图和取色结果，本次没有提交这些产物（与 #200、#204 的做法一致）。

### 26.9 未做
- 触达相关的两处复制（`T0OutreachPanel`、线索详情的外联草稿）仍直接调用 `navigator.clipboard`：属于「商机与触达」，
  随该功能恢复时再换成 `copyText`。
- 需要改引擎或 BFF 的问题（#4b、#13b、#19、#22 与偶发 502）不在本轮；第二步到第四步（术语、资格规则与回测、
  全局进度条、找买家改名分组）等产品决定。
- 真实数据下的走查未做，待用户在 5666 验收。

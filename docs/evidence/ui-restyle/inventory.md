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

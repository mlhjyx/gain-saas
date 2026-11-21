# P3 对零：列表与详情页统一范式

> 对照基线：`docs/evidence/ui-restyle/inventory.md` §2.2–§2.12、§2.10
> 目标：统一「筛选区 + 表格/列表 + 空状态三路径」与详情页头；功能、API、表格列、表单/校验、弹窗不变。

## 1. 共享层（一次收敛，所有列表/详情页继承）

| 组件 | 改动 | 影响页面 |
|---|---|---|
| `PageContainer` | 间距 18→24；页宽/内边距改用 `--gs-page-max` / `--gs-page-pad` | tasks、campaigns、qgos、notifications、replies、privacy 等 |
| `PageHeader` | H1 24/500（原 24/700）；副标题 16/24（原 13.5/1.7）；kicker 12/500、字距 0.04em | tasks、campaigns、qgos、notifications、leads/detail 等 |
| `SettingsShell` | 导航圆角 12→10、链接 14px、H1 24/500、副标题 16/24、栅格 200px + 24px | settings 五页（Phase 4 再逐页） |
| `EmptyState`（新增） | 40px 图标 chip + 标题 + 说明 + 2–3 条路径；`compact` 变体 | 列表页空状态 |

## 2. 列表页空状态：至少 2 条真实起步路径

| 页面 | 主路径 | 次路径 | API/表单变化 |
|---|---|---|---|
| `/find-buyers` | `emptyCta` 设定目标客户画像（`openCreate`） | 公司档案 `/companies`；挖掘任务 `/tasks` | 无 |
| `/leads`（无 ICP） | `goFindBuyers` → `/find-buyers` | 公司档案 `/companies`；挖掘任务 `/tasks` | 无 |
| `/leads`（无线索） | `emptyCta` → `/find-buyers` | 公司档案 `/companies`；挖掘任务 `/tasks` | 无 |
| `/companies` | `emptyCta` 开始建档（`openWizard`） | 买家线索 `/leads`；管理员：数据源 `/settings/sources`；成员：挖掘任务 `/tasks` | 无 |
| `/tasks` | `emptyCta` → `/find-buyers` | 买家线索 `/leads`；公司档案 `/companies` | 无 |
| `/campaigns` | `newCampaign` 新建计划 | 商机 `/qgos`；触达 `/growth?tab=outreach` | 无 |
| `/qgos` | `emptyCta` → `/leads` | 战役计划 `/growth?tab=campaigns`；触达 `/growth?tab=outreach` | 无 |
| `/growth?tab=outreach` | `newBatch` 新建批次 | 回复 `/growth?tab=replies`；买家线索 `/leads` | 无 |
| `/growth?tab=replies` | 触达批次 `/growth?tab=outreach` | 买家线索 `/leads` | 无 |
| `/growth?tab=reviews` | 度量 `/growth?tab=metrics` | 买家线索 `/leads` | 无 |
| `/growth?tab=metrics` | 判定复核 `/growth?tab=reviews` | 买家线索 `/leads` | 无 |
| `/notifications` | 工作空间 `/workspace` | 买家线索 `/leads` | 无 |

> 空状态复用原有文案 key；没有新增业务文案。新增的只是导航路径按钮。

## 3. 详情页头统一

| 页面 | 改造前 | 改造后 |
|---|---|---|
| `/leads/:leadId` | `PageHeader` 24/700 + 13.5 副标题 | 继承 P3 `PageHeader` 24/500 + 16/24 |
| `/tasks/:taskId` | `PageHeader` | 同上 |
| `/campaigns/:campaignId` | `PageHeader` | 同上 |
| `/find-buyers` 详情弹窗 | 自定义头部 | 页头/卡片沿用 `--gs-*`；弹窗结构不动 |
| `/companies` | 自定义 `.cp__head` 24/700 + 13.5 | 24/500 + 16/24 |
| `/runs/:runId` | 自定义 `.run__head` 26/700 + kicker 11.5/700/.18em | 24/500 + kicker 12/500/.04em |
| `/leads` 列表头 | 自定义 24/700 + 13.5 | 24/500 + 16/24 |
| `/find-buyers` 列表头 | 自定义 24/700 + 13.5 | 24/500 + 16/24 |

## 4. 未改动项（硬性守恒）

- 所有 API 调用、方法、路径、触发时机：未改。
- 所有表格列、dataIndex、列标题、分页/筛选/排序：未改。
- 所有表单字段、默认值、校验规则、错误文案：未改。
- 所有弹窗/抽屉/确认框：未改。
- 所有权限点/角色判断：未改。
- 所有 locales 既有 key/value：未改。

## 5. 验证

- `pnpm --filter @vben/web-antd typecheck` ✅
- 待 P3 构建后：`dark-mode` / `responsive` / `zero-jargon` / `notifications` / `a11y` / `nav-shell` + 全量 `e2e:nav`。
- 截图：`p3-leads-light.png`、`p3-leads-dark.png`、`p3-companies-light.png`、`p3-companies-dark.png`、`p3-task-detail-light.png`。

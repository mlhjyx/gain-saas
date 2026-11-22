# P2 对零：/workspace 行动驾驶舱

> 对照基线：`docs/evidence/ui-restyle/inventory.md` §2.1
> 改造范围：`apps/web/src/views/workspace/index.vue`、`locales/langs/{zh-CN,en-US}/gainos.json`（只新增 key）
> 原则：`AGENTS.md` §5.1「目标简单，设计简单，实现简单；砍掉标语、提示文字和次要标签」。

## 1. API 对零（14 个调用全部保留）

| API | 改造前 | 改造后 | 说明 |
|---|---|---|---|
| `session()` GET `/auth/session` | ✅ `load()` | ✅ `load()` | 未改 |
| `companies()` GET `/companies` | ✅ | ✅ | 未改 |
| `icps()` GET `/icps` | ✅ | ✅ | 未改 |
| `notifications()` GET `/notifications` | ✅ | ✅ | 未改 |
| `members()` GET `/members` | ✅ | ✅ | 未改 |
| `discoveryRunLinks()` GET `/runs?icpId=` | ✅ | ✅ | 未改 |
| `queryPlans()` GET `/icps/:id/query-plans` | ✅ | ✅ | 未改 |
| `leadQueues()` GET `/icps/:id/lead-queues` | ✅ | ✅ | 未改 |
| `leads()` GET `/leads?icpId=&limit=200` | ✅ | ✅ | 未改 |
| `discoveryRun()` GET `/discovery-runs/:id` | ✅ | ✅ | 未改 |
| `companyCompleteness()` GET `/companies/:id/completeness` | ✅ | ✅ | 未改 |
| `readNotification()` POST `/notifications/:id/read` | ✅ | ✅ | 通过 `openNotification` |
| `readAllNotifications()` POST `/notifications/read-all` | ✅ | ✅ | 通过 `markAllRead` |

## 2. 操作对零

| 操作 | 改造前 | 改造后 |
|---|---|---|
| 刷新 | `common.refresh` / `refreshing` | 保留，页头右侧 |
| 错误重试 | 错误条 `common.retry` → `load()` | 保留 |
| 通知点击 | `openNotification`：标已读 + http(s) 新窗/内部跳转 | 保留；提醒列表项点击 |
| 全部已读 | `markAllRead`，未读数清零，派发事件 | 保留；提醒标题右侧 |
| 未读数 | `notificationsUnread` | 保留 |
| KPI 6 个跳转 | 公司档案 / 目标客户画像 / 挖掘任务 / 待判断线索 / 值得跟进 / 团队 | 6 个 KPI 按钮全部保留，跳转目标不变 |
| 下一步 CTA | `nextAction.action` → `nextAction.to` | 保留为「今日建议」唯一主按钮 |
| 最近线索行 | `openLead(lead)` → `/leads?queue=...` | 保留 |
| 查看全部线索 | `/leads` | 保留 |
| `?panel=notifications` 高亮 | `#workspace-notifications` + 滚动 + 2.6s 高亮 | 保留；id 与 `highlightNotifications` 不变 |
| 角色/公司名 | `roleLabel` / `workspaceName` / `displayName` | 保留；页头身份行 |

## 3. 有意删除的可见文案（按 AGENTS §5.1）

| 删除项 | 原位置 | 理由 | 信息是否还在 |
|---|---|---|---|
| 问候标语 `{greeting}，今天让增长往前一步。` | H1 | 标语，布局已表达“工作空间” | H1 改为公司名；无公司名时回落 `gainos.workspace.title` |
| `pipelineSummary` 长状态句 | 页头副标题 | 与阶段漏斗/行动清单重复 | 阶段值、行动标题、提醒仍表达同一状态 |
| KPI `hint` 副文案 | KPI 卡内 | 次要说明，占版面 | 保留为 KPI 按钮 `title`（悬停可读） |
| `nextAction.desc` 说明段 | 下一步深色 hero | 与行动清单重复 | 保留为「今日建议」标题的 `title` |
| 通知 emoji 图标 | 通知列表 | 装饰性、跨平台不一致 | 改为「异常/机会/建议」文字徽章 |
| 「业务概览」小标题 | KPI 区 | 与「今日摘要」重复 | 合并进「今日摘要」 |
| 横向五步进度条（旧视觉） | 步骤区 | 信息密度低 | 改为阶段漏斗卡片 + 进度条 + 数值 |

## 4. 新增（不依赖新 API）

| 新增 | 数据来源 | 说明 |
|---|---|---|
| 数据同步状态徽章 | `lastLoadedAt`（`load()` 成功时间） | 加载中/失败/已同步三态 |
| 阶段漏斗 5 卡 | 现有 `companies/icps/plans/runLinks/leads` | 进度百分比由现有状态派生 |
| 行动清单 | 现有 `nextAction` 分支 + 计数 | 按紧迫度排序；按钮跳转复用原目标 |
| 待办/已归档 | `localStorage['gainos.cockpit.archived.v1']` | 只影响本机展示；不写业务状态 |
| 提醒分类 | 现有通知类型 + sanctions/run 状态 | 文本徽章 + 颜色，不单靠颜色传义 |
| 今日建议 | 现有 `nextAction` | 一句话 + 唯一主按钮 |

## 5. 明暗与响应式

- 所有新增颜色/边框/阴影均来自 `--gs-*` 双主题令牌；无硬编码只亮色值。
- 桌面：主列 + 侧列；≤1100px 单列；≤640px KPI/阶段单列或两列，无横向溢出。
- 截图：`p2-workspace-light.png`、`p2-workspace-dark.png`、`p2-workspace-mobile-light.png`。

## 6. 验证

- `pnpm --filter @vben/web-antd typecheck` ✅
- `pnpm build` ✅
- `zero-jargon` / `dark-mode` / `responsive` / `notifications` / `a11y` / `nav-shell` ✅（P2 阶段 targeted）
- 全量 `pnpm e2e:nav` 见 P2 提交后的阶段验收记录。

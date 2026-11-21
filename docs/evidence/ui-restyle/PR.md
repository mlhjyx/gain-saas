## 目标

把 `apps/web` 重构为 AgentSDR 的视觉语言 + Sondara 的操作流，功能 100% 守恒，明暗双主题同批交付，质量门全绿。范围按 2026-11-22 指示收敛为用户登录后的系统内页面；`/ops`、登录/注册页不改造。

## 交付（按阶段独立 commit）

| 阶段 | Commit | 内容 |
|---|---|---|
| P0 | `cf83bf5` | 《页面×功能盘点表》、AgentSDR token 映射表、基线 typecheck 修复 |
| P0.1 | `0b0100a` | AGENTS.md 简洁性原则；锁定范围/找回密码/locales 决策 |
| P1 | `a7e7ccc` | AgentSDR token → AntDV ConfigProvider、品牌蓝 #335CFF、`--gs-*` 双主题、6 个业务分组侧边栏 |
| P1 fix | `1a5a899` | onboarding 标签 AA 对比度、分组导航 e2e 修复 |
| P2 | `7f61359` | `/workspace` 行动驾驶舱：今日摘要/阶段漏斗/行动清单(待办/已归档)/提醒/今日建议；14 个 API 全保留 |
| P3 | `9802418` | 列表/详情统一范式：PageHeader 24/500、空状态 2–3 条真实路径、共享 EmptyState |
| P4 | `badddca` | 设置五页：去掉重复二级导航、空状态路径、空响应健壮性 |
| P5 | 本次 | 终核对零声明、ui-design-guidelines 更新、全量验收 |

## 关键决策

- **简单性原则**（AGENTS §5.1）：砍掉标语、提示文字和次要标签；功能性标签/校验/错误/空态/操作入口/API 不删。
- **登录/注册/ops 不改造**：只继承全局 token；`/auth/forget-password` 保持 redirect，登录页提示即找回路径。
- **locales**：既有 key/value 零改动；只新增中英文同步的新 key（分组、驾驶舱、members.emptyTitle）。
- **侧边栏分组**：路由保持扁平，只在 Vben 菜单数据层收进 6 组；相关 e2e 改为“展开分组 → 叶子页面可达”的等价断言。
- **设置导航**：删除页内重复二级导航，统一主侧栏「设置」分组。

## 功能守恒

- `git diff ecebda2..HEAD -- apps/web/src/api apps/server packages/engine-client apps/web/src/store apps/web/src/router/guard.ts apps/web/src/router/access.ts apps/web/src/router/routes` 输出为空。
- locales 无删除行；既有 key/value 未改。
- 所有表单字段/校验/表格列/弹窗/权限点未改；有意变更（空状态路径、驾驶舱文案精简、设置导航收敛）逐项记录在：
  - `docs/evidence/ui-restyle/inventory.md` §10
  - `docs/evidence/ui-restyle/p2-workspace-parity.md`
  - `docs/evidence/ui-restyle/p3-list-detail-parity.md`
  - `docs/evidence/ui-restyle/p4-settings-parity.md`

## 验收

- `pnpm typecheck` ✅
- `pnpm build` ✅
- `pnpm lint:terms` ✅
- `pnpm lint:date` ✅
- `pnpm e2e:nav` ✅（P5 最终运行：**149 passed / 1 skipped**；P2 全量曾出现 1 次 `leads-detail` 并发抖动，单独复跑通过）
- 深色：`dark-mode` ✅；响应式：`responsive` ✅；a11y：`a11y` ✅；零术语：`zero-jargon` ✅

## 证据

- 盘点与 token：`docs/evidence/ui-restyle/inventory.md`、`token-mapping.md`
- 截图（明/暗）：`p1-*`、`p2-*`、`p3-*`、`p4-*`
- 对零文档：`p2-workspace-parity.md`、`p3-list-detail-parity.md`、`p4-settings-parity.md`

## 人工验收（待真实用户）

按任务要求让没看过文档的人独立完成：登录 → 工作空间 → 发起一次获客 → 查看线索详情 → 处理一条提醒。记录点击次数与卡点；任何需要口头解释的地方即不通过。自动化主链路已覆盖，但不替代这一步。

## 目标

修复用户实测反馈：菜单栏未按 AgentSDR 风格改造。SDR 的实际形态是「所有操作在左侧栏、顶栏无菜单、菜单指示清晰」——本 PR 把侧栏结构和操作归位逐项对齐 `AgentSDR/src/components/Sidebar.tsx`。

## 根因

1. Vben 菜单按「可折叠分组（手风琴）」渲染：多数菜单项默认收起，点分组才展开——与 SDR「分组小标签 + 菜单项全部可见」结构不同，看起来自然不像 SDR，指示也不清晰。
2. 主题/语言/搜索仍在顶栏——SDR 把这些全部放在侧栏（品牌行主题切换、顶部 Jump-to 搜索框），顶栏没有任何全局操作。

## 方案（packages/ 禁改 → 覆盖层）

新增 `apps/web/src/components/gainos/sdr-sidebar.vue`，fixed 覆盖层渲染 SDR 原版结构；桌面隐藏 Vben 菜单（`gainos.css`，<768px 移动抽屉不受影响）。

### SDR 规格 → 实现（逐项）

| SDR（Sidebar.tsx） | 实现 |
|---|---|
| 分组小标签（12px 灰） | `.sdr-section__label` |
| 行 h-9(36px) / px-2 / rounded-lg(8px) / 字重 500 | `.sdr-row` |
| **active = 灰底药丸 + 近黑文字**（bg-bg-weak-50 + text-strong-950，无彩条） | `.sdr-row.is-active` |
| hover = 同灰底 | `.sdr-row:hover` |
| 图标 active 实心近黑 / 非激活 soft 灰 | icon 随状态 |
| **分组永远可见（无手风琴）** | sections 拍平 accessMenus，11 项直接可见 |
| Jump-to 搜索框（h-9 ring-1 + ⌘K kbd）在侧栏顶部 | `.sdr-search` → 命令面板 |
| 折叠图标窄栏 + tooltip | `.sdr-rail`（Vben 左下折叠按钮触发） |
| 品牌行右侧主题切换 | `sdr-brandtools`（aria-label dark/light 保持 e2e 兼容） |
| 顶栏无菜单无全局操作 | 顶栏只剩：侧栏开关、刷新、通知、用户菜单 |

### 缓存归一扩展

`BRAND_PREFERENCES` 增加 `widget.{themeToggle,languageToggle,globalSearch}=false`——老缓存里的顶栏开关会让顶栏重新长出主题/语言按钮。

## 保留项（功能守恒）

- 通知、用户菜单保留在顶栏：SDR 无此二者，删了断功能；侧栏无承载位。
- 移动端（<768px）抽屉仍用 Vben 菜单，active 同步改为 SDR 灰底药丸。
- 路由 / api / server / packages / store / guard / access / locales key：零改动。
- 侧栏标签经 `$t(menu.name)`（Vben wrapperMenus 同款语义）。

## 验证

- `pnpm typecheck / build / lint:terms / lint:date / e2e:nav` 全绿（e2e 158 passed / 1 skipped，含迁移后的 nav-shell / settings-shell / main-chain / cache-normalize / measure）
- 量测（measurements.json）：行 36px / 字号 14 / 字重 500 / active bg rgb(245,245,245) + color rgb(23,23,23) / 圆角 8px / 标签 12px / 6 分组全可见
- 折叠窄栏 e2e 点通（图标导航 + 展开恢复）
- 颜色白名单：渲染 13,946 样本 violations 0（含侧栏覆盖层、明暗两主题、nprogress 显式断言）；源码 88 文件 0 违规
- 截图：`pass4/sidebar-{light,dark}.png`、`sidebar-collapsed-light.png`、`after-{workspace,leads}-*.png`；`inventory.md` §13

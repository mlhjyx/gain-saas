## 目标

修复 PR #184 后用户实测仍看到的三个根因问题：旧缓存导致绿色主题/顶栏菜单残留（A）、侧边栏未完全对齐 AgentSDR（B）、交互「无感」（C1-C10）。不重做已合格部分。

## 修复 A：缓存强制归一（根因，最高优先级）

**根因**：Vben 偏好合并是「localStorage 缓存优先于代码默认」。老访客缓存里的旧绿色 `colorPrimary` 经内联 `--primary` 驱动 nprogress 进度条与壳层派生色；旧 `layout=header-nav` 让顶栏渲染菜单；logo 是同 URL 图片缓存（内容已改蓝、URL 未变）。

- **方案（b）**：`main.ts` 在 `initPreferences` 后 `updatePreferences(BRAND_PREFERENCES)` 强制归一 `colorPrimary=#335CFF`、`builtinType=default`、`logo.source/sourceDark=/logo-gainos.svg?v=pass3`、`layout=sidebar-nav`，并回写缓存。`theme.mode`/`sidebar.width`/`collapsed`/语言保留用户值。不选方案 (a)（版本号 key 一次失效会连明暗/语言一起丢）。
- logo/favicon/apple-touch-icon URL 全部带 `?v=pass3` 击穿图片缓存。
- `api/core/user.ts:18` 头像兜底 `#00B96B`→`#335CFF`（任务点名的一行；api/ 其余零改动）。
- **A4 关键回归**：`pass3-cache-normalize.spec.ts` 预置旧缓存（含 `{value:…}` 信封）→ 断言进度条 `rgb(51,92,255)`、侧栏渲染、banner 零菜单项、logo 版本 URL、明暗可切、归一已回写。**反向验证过**：禁用归一代码该测试变红。

## 修复 B：纯侧边栏

- banner 断言 `menuitem=0`；布局钉死 sidebar-nav（代码默认 + 缓存归一双保险）。
- 侧栏规格保留 pass2（组标签 11px、叶 32px/500、active 蓝左条+浅灰底、8px 圆角）；底部左下折叠开关（Vben 内置）+ 右下新增帮助按钮（快捷键 Popover）。

## 修复 C：交互（C1-C6 全交付，C7 有意跳过，C8-C10 交付）

| 项 | 交付 |
|---|---|
| C1 | 命令面板 `command-palette.vue`：⌘K/Ctrl+K、模糊搜索全部页面+6 个动作（既有路由）、↑↓/回车/Esc；关闭内置 GlobalSearch 防双 ⌘K |
| C2 | AsyncSection/设置四页 Spin→antd Skeleton，加载文案 sr-only |
| C3 | `use-count-up.ts` rAF 动效（4 个数值 KPI）+ KPI 入场错峰；环比箭头跳过（无上期数据，inventory §12 标注） |
| C4 | 漏斗五阶段卡可点（pass2 路由）+ hover 抬升 2px |
| C5 | 工作台顶部 hero 大卡：建议+主 CTA「立即处理」+互补次链接 |
| C6 | 行动清单「完成」：划线 320ms→归档→计数即时 -1→toast；无完成 API（inventory §12 标注） |
| C7 | **跳过**：列表已有常显操作列，hover 浮现与触控/可发现性冲突（有意偏离） |
| C8 | chips 即时生效（已有）+ 激活 chip ✕ 单独移除 |
| C9 | 主按钮 hover 上移/active 下压、卡片 hover 抬升、fade-slide 页面切换（Vben 默认确认启用） |
| C10 | 空状态双路径（pass2 已统一，本轮无回归） |

## 功能守恒

- `api/`（除 user.ts:18）、`apps/server/**`、`packages/**`、`store/**`、guard/access/路由模块：零改动。
- 既有 locales key/value 零改动；新文案为组件内双语字符串。
- 有意差异仅：hero 卡替代侧栏建议卡、Spin→Skeleton、顶栏搜索→命令面板、侧栏帮助按钮、行动清单「完成」按钮。

## 验证

- `pnpm typecheck` ✅ `pnpm build` ✅ `pnpm lint:terms` ✅ `pnpm lint:date` ✅
- `pnpm e2e:nav` ✅：**156 passed / 1 skipped**（新增 pass3-cache-normalize / pass3-color-scan / pass3-interactions，nav-shell 增顶栏断言）
- 颜色白名单：渲染 DOM 11,259 样本 violations 0（明暗两主题）；nprogress bar 显式断言 `rgb(51,92,255)`；源码扫描 87 文件 violations 0
- 双环境验证：无痕会话（全套 spec 默认）+ 旧缓存会话（pass3-cache-normalize 复现用户本人场景）均绿

## 证据（docs/evidence/ui-restyle/pass3/）

- `before-*.png`（= pass2 后）/ `after-*.png`（workspace、leads、settings/members，明暗各一套）
- `color-scan.txt/json`、`source-color-scan.txt/py`
- inventory.md §12（对零 + 降级项标注）

## 盲测差异清单（≥5 处，供真人 10 秒对比）

1. ⌘K 命令面板（顶栏搜索按钮 + 弹层）
2. 加载骨架屏（原转圈）
3. 工作台顶部 hero 建议大卡
4. 漏斗卡 hover 抬升可点
5. 侧栏纯净化（顶栏无菜单）+ 右下帮助按钮
6. KPI 数字滚动入场
7. 行动清单「完成」划线 + toast

人工盲测与录屏仍需真人执行；自动化（pass3-interactions）已覆盖 C1/C5/C6 的点通路径。

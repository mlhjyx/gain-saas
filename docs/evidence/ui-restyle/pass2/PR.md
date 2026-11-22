## 目标

修复 PR #183 遗留的三个实测问题，不重做已合格部分：主题色彻底统一、侧边栏/卡片/按钮/列表对齐 AgentSDR、工作台补齐 Sondara 动作出口。

## 修复 1：主题色统一

- 品牌蓝只保留 `#335CFF` + hover/active `#3559E9`（blue-600）+ 浅底/描边衍生档；删除 `#2547D0` / `#1F3BAD` / `#4D82FF` / `#2563eb` / `#4f46e5`。
- success 只保留 `#1A7544`（AntDV `colorSuccess` 同值）；删除装饰性 `#00B96B` / `#1FC16B` / `#3EE089` / `#008f52` / `#e8f9f0`。
- warning `#B75310`、error `#D02533` 唯一值；删除 `#FA7319` / `#FFA468` / `#FB3748` / `#FF6875`。
- logo / favicon / apple-touch-icon / 登录注册品牌面板 / loading 页装饰绿全部改为品牌蓝或中性灰；登录注册/ops 仅颜色归一，结构与行为未改。
- Vben 壳层中性 token 覆盖为纯中性灰；`api/core/user.ts` 旧绿色（本轮禁止改 api/）在 UI 层 data URI 归一为品牌蓝。
- **源码扫描**：85 个文件，0 违规（`source-color-scan.txt`）。
- **渲染 DOM 扫描**：15 页 × 明暗两主题，10,963 个样本；中性 10,249 / 品牌蓝 686 / success 12 / warning 14 / error 2；**unknown 0**（`color-scan.txt` / `color-scan.json`）。

## 修复 2：菜单/卡片/按钮/列表

- 侧边栏：分组标签 36px 行高、11px/500/字距 0.08em；叶子项 32px、px-8、14px/500；active = 3px 品牌蓝左条 + 蓝字 + `#F5F5F5` 浅灰底；hover 浅灰。
- 卡片：1px `#EBEBEB` 边 + `0 1px 2px rgba(10,10,10,.03)` 阴影 + 10px 圆角；大容器/弹层 20px。
- 主行动按钮 9999px 全圆（含 AntDV primary 与原生主 CTA）；次按钮描边/10px。
- `/leads`：撤掉常驻队列卡，改为工具栏（队列 chips + 搜索框），列表通栏；队列筛选语义不变；搜索为纯前端过滤已加载线索，不新增 API。
- 量测：`measurements.json`（group 36 / title 11 / leaf 32 / weight 500 / active bar 3px / card 10px+1px+shadow / CTA 9999px / queueCards 0 / toolbar 1 / search 1）。

## 修复 3：Sondara 闭环

- 今日建议（提醒之后）：一句话 +「立即处理」全圆主按钮，跳转 `nextAction.to`；交互测试点通到 `/companies`。
- 经营提醒：主行 + 右侧「去处理」按钮；通知类先 `POST /notifications/:id/read` 再跳转；交互测试点通到 `/leads`，read 调用 1 次。
- 今日行动清单：条目由现有状态派生，**无完成 API**，本轮只读并标注「在目标页完成」；到目标页完成后返回，`load()` 重新派生，清单与「今日脉搏 · 待办」计数同步更新。
- 跳转目标全部对照路由基线，无新增路由、无死链。

## 功能守恒

- `api/`、`apps/server/**`、`packages/**`、`store/**`、`router/guard.ts`、`router/access.ts`、所有路由模块：零改动。
- 既有 locales key/value：零改动；「立即处理」「去处理」「在目标页完成」为组件内按 locale 生成的展示文案，未新增/修改 locale key。
- 表单/校验/表格列/弹窗/权限点：未改。
- 有意差异仅：`/leads` 队列卡→工具栏+搜索、侧边栏分组样式、登录注册 ops 颜色归一、行动清单只读标注；均记录在 `inventory.md` §11。

## 证据

- 前后对比：`docs/evidence/ui-restyle/pass2/before-*.png` / `after-*.png`（workspace、leads、settings/members，明暗各一套）。
- 扫描与量测：同目录 `source-color-scan.*`、`color-scan.*`、`measurements.json`。
- 交互：`apps/web/e2e/pass2-interactions.spec.ts`。

## 验证

- `pnpm typecheck` ✅
- `pnpm build` ✅
- `pnpm lint:terms` ✅
- `pnpm lint:date` ✅
- `pnpm e2e:nav` ✅：**152 passed / 1 skipped**（含 pass2 color scan / measure / interactions 三个新增 spec；原 150 个用例全部保留）
- 现有质量门全绿，未放宽任何断言。

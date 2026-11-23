# 界面设计系统（Ant Design 基线 · 企业级）

> 2026-11-23 起生效。所有登录后业务页面（`/ops`、登录/注册/异常页除外）以本文为准；
> 色值来源仍是 [token-mapping.md](../evidence/ui-restyle/token-mapping.md) 与 `apps/web/src/app.vue` 的 `GS_BRAND`。
> 视觉目标：成熟、稳定、可长期维护的企业级数据平台（参考腾道一类 B2B 数据系统），不追逐装饰性潮流。

## 1. 唯一实现路径

- 交互组件一律使用 **ant-design-vue 4.x**（Button/Input/Select/Form/Table/Modal/Drawer/Tabs/Steps/Alert/Tag/Empty/Skeleton…）。
- 页面不允许再新增自定义按钮/输入/表格/弹层类；确需组合时使用 `components/gainos/ui/` 下的 `Gs*` 薄封装。
- 封装内部必须 `import { Card, Tag, Empty, Modal, Table, Statistic } from 'ant-design-vue'` 后用 PascalCase 组件；**禁止写 `<a-card>`/`<a-tag>` 字符串标签**——本应用没有全局注册 AntDV，字符串标签会渲染成无样式自定义元素（卡片 0 padding、标题/标签丢失）。
- 页面级 `<style scoped>` 目标为 0 行；布局用 `a-row/a-col/a-space/a-flex`，视觉全部来自 token。
- 主题唯一来源：`app.vue` 的 `ConfigProvider`（`GS_BRAND` + `componentTokens`）。禁止在页面里写 `.ant-* { … !important }`。
- 反馈（成功/失败提示、确认框、顶部通知）一律走 `apps/web/src/feedback.ts`（`App.useApp()` 上下文），不使用静态 `message/notification/Modal.confirm`，不使用 `window.confirm/alert`。

## 2. 字阶

| 用途 | 字号 | 字重 | 说明 |
|---|---|---|---|
| 页面标题 H1 | 20px | 600 | 一屏一个，位于 `GsPage` |
| 分区标题 | 16px | 600 | 卡片组/区块标题 |
| 正文与控件 | 14px | 400 | antd `fontSize` 默认 |
| 表格正文 | 13px | 400 | `GsTable` 默认 |
| 表头/辅助 | 12px | 500 | 表头、说明、时间戳 |
| 数字 | 14px | 500 | `font-variant-numeric: tabular-nums`，右对齐 |

## 3. 间距与布局

- 间距刻度：4 / 8 / 12 / 16 / 24 / 32（`--gs-space-*`）。
- 页面：内容区左右 `--gs-page-pad`（clamp 20–32px，桌面 32px），最大宽度 `--gs-page-max`（1280px）；区块之间 `24px`，区块标题与内容 `12px`。
- 卡片：body padding 24px（`GsCard`），卡片间距 16–24px；页面边缘与卡片边缘都必须留出可见留白。
- 栅格：12 列；桌面卡片最小宽度 280px；窄屏单列。

## 4. 圆角与边框

- 全部 10px（按钮/输入/卡片/弹窗/下拉）；头像与圆形图标除外。
- 边框 1px `--gs-border`（#EBEBEB / 暗色 #262626）；分割线 `--gs-divider`。
- 阴影只用 xs（卡片）与 modal（弹窗）；不使用彩色光晕。

## 5. 色彩

- 主色：#335CFF（hover #3559E9）；语义色：success #1A7544、warning #B75310、error #D02533。
- 中性灰阶：文字 #171717 / #5C5C5C / #7B7B7B；背景 #FFFFFF / #F7F7F7 / #F5F5F5。
- **状态色只允许出现在 Tag、Alert、趋势数字**；其余界面保持中性。
- 深色主题同结构，值见 `GS_BRAND.dark`。

## 6. 表格（企业级数据页的核心）

- `GsTable`：`size="middle"`，表头 12/500 + `--gs-table-head` 底，行高 48，hover 浅灰，无外框。
- 首列为主信息（公司/线索名，14/500）；数字列右对齐 + tabular-nums；状态列用 `GsTag`。
- 空态统一 `GsEmpty`；加载统一 `a-skeleton`；分页默认 20/页，超过 50 条显示总数。

## 7. 表单

- label 上置（12/500），控件高 40，错误 12px 语义红（`a-form-item` 自带）。
- 同一行最多 2 个控件；主提交与次操作分列右侧（Modal 页脚右对齐）。

## 8. 反馈与弹层

- 成功：`feedback.message.success`（3s 自动消失）。
- 可恢复失败：`feedback.message.error`；页面级持久错误：`ErrorNotice`（a-alert，保留「发生了什么/为什么/怎么办 + 技术详情」三层）。
- 确认：`feedback.modal.confirm`；行内危险操作 `a-popconfirm`。
- 顶部通知：`feedback.notification.*`（暗色自动取 token）。
- Modal：10px 圆角，页脚右对齐「取消 / 确认」，危险操作用 `danger`。

## 9. 动效

- ≤150ms，只动颜色/透明度/阴影；禁止位移、缩放、弹跳。
- 加载态用骨架屏；列表进入不加动画。

## 10. 可访问性与测试锚点

- 保留语义：H1/H2 层级、`role=dialog/alert/status`、`role=tab` 顺序与文案、`aria-pressed`、`<main>`。
- 测试锚点统一 `data-gs="<area>"`（如 `data-gs="lead-card"`、`data-gs="queue-toolbar"`）；
  旧的 `.wk__*/.ld__*/.cp__*` 等页面类名不保留。
- 错误三层块必须保留 `.error-notice__details summary` 的「技术详情」折叠（既有 spec 依赖）。

## 11. 判定结果（C1–C5）的展示契约（2026-11-23）

引擎把五维评分写成一段聚合文本（`judge-aggregate/v1：verdict=…，reasonCodes=…` + `C1_MATERIAL pass（score 8）：…`）。
**这段原文只能进「技术详情」，租户界面一律渲染解析后的业务语言。**

- 解析：`apps/web/src/views/leads/judge.ts`（`parseJudge`）。维度顺序 C1→C5，分数 0–10，`null`=证据不足；
  兼容字符串、字符串数组、JSON 字符串与对象包装；解析失败时退回「机器结论 + 人话理由」。
- 文案：维度名 `gainos.leads.criteria.*`（产品品类 / 买家角色 / 生产工艺 / 经营模式 / 企业规模），
  状态走 `@gain-saas/shared` 的词表（符合 / 偏弱 / 不符 / 证据不足 / 不适用）。
  模型理由里的 `ICP` 用 `humanizeRationale()` 换成「目标客户画像」。
- 列表卡（`views/leads/lead-card.vue`）：公司（首字母牌位 + 国家/域名 + 行业/规模）→ 评分（分数 + 分档）
  → 判断结果/原因（决定性维度的一句话）→ 五维摘要（图标 + 结论 + 分数）→ 操作（值得跟进/暂不跟进/⋯）。
  「待我判断」的卡片用 3px 左侧强调条；展开后显示逐维理由，机器码只出现在折叠的「技术详情」。
- 详情（`views/leads/detail.vue`）：判断结果 hero（总分 + 分档 + 状态 + 维度计数 + 关键理由 + 核心证据）
  + 五维雷达（`GsRadar`，纯 SVG）+ 逐维明细（状态、0–10 分条、理由）。
  证据不足的维度按 0 绘制并在图下注明；`scores` 的八维明细作为补充卡片保留。
- 红线：`C1_MATERIAL`、`reasonCodes`、`judge-aggregate`、裸枚举不得出现在可见文本中
  （`leads-judge.spec.ts` 用真实形状的数据锁定）。

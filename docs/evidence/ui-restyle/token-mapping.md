# AgentSDR Token → AntDV / GainOS Token 映射表

> 文档 ID：`DOC-EVIDENCE-UI-RESTYLE-TOKEN-MAPPING-001`
> 来源：`/home/xin/gain-ref/AgentSDR/src/app/globals.css`
> - 色彩/圆角/字号/阴影 token：约 38–620 行
> - 暗色块：`.dark` 从 705 行起（另有 `prefers-color-scheme` 块 620–700 行）
> - 组件用法参考：`src/components/alignui/button.tsx`、`src/components/analytics/kit/Frame.tsx`、`src/components/page/EmptyState.tsx`、`src/components/ui/StatCard.tsx`
> 色值换算：OKLCH → OKLab → linear sRGB → gamma，脚本结果见下表。换算脚本不进入仓库。
> 使用方式：P1 直接把“AntDV token”列写进 `apps/web/src/app.vue` 的 ConfigProvider；把“CSS 变量”列写进 `apps/web/src/styles/gainos.css`。不得凭印象改数值。

---

## 1. 中性色（纯中性，无色度）

| AgentSDR token | OKLCH 原文 | Hex | 用途 | AntDV token / CSS 变量 |
|---|---|---|---|---|
| `--color-gray-950` | `oklch(20.46% 0.0000 0)` | `#171717` | 最强文字 / 暗色底 | `colorText`（light）；`colorBgBase` / `colorBgLayout`（dark）；`--gs-gray-950` |
| `--color-gray-900` | `oklch(22.64% 0.0000 0)` | `#1C1C1C` | 暗色卡片面 | `colorBgContainer`（dark）；`--gs-gray-900` |
| `--color-gray-800` | `oklch(26.86% 0.0000 0)` | `#262626` | 暗色边框 / 弹层 | `colorBgElevated`（dark）；`colorBorder`（dark）；`--gs-gray-800` |
| `--color-gray-700` | `oklch(32.11% 0.0000 0)` | `#333333` | 暗色强边框 | `colorBorderSecondary`（dark）；`--gs-gray-700` |
| `--color-gray-600` | `oklch(47.48% 0.0000 0)` | `#5C5C5C` | 次级文字 | `colorTextSecondary`（light）；`--gs-gray-600` |
| `--color-gray-500` | `oklch(58.29% 0.0000 0)` | `#7B7B7B` | 三级文字 / 占位 | `colorTextTertiary`（light）；`colorTextTertiary`（dark，仅非关键文字）；`--gs-gray-500` |
| `--color-gray-400` | `oklch(71.55% 0.0000 0)` | `#A3A3A3` | 暗色次级文字 | `colorTextSecondary`（dark）；`colorTextQuaternary`（light）；`--gs-gray-400` |
| `--color-gray-300` | `oklch(86.07% 0.0000 0)` | `#D1D1D1` | 禁用文字 / 强分隔 | `colorTextDisabled`（light）；`--gs-gray-300` |
| `--color-gray-200` | `oklch(94.01% 0.0000 0)` | `#EBEBEB` | 1px 卡片/输入边框 | `colorBorder`（light）；`--gs-gray-200` |
| `--color-gray-100` | `oklch(97.02% 0.0000 0)` | `#F5F5F5` | 分隔线 / 浅填充 | `colorSplit` / `colorBorderSecondary`（light）；`--gs-gray-100` |
| `--color-gray-50` | `oklch(97.61% 0.0000 0)` | `#F7F7F7` | 页面底色 / 弱面 | `colorBgLayout`（light）；`--gs-gray-50` |
| `--color-gray-0` | `oklch(100.00% 0.0000 0)` | `#FFFFFF` | 卡片面 / 暗色文字 | `colorBgContainer` / `colorBgElevated`（light）；`colorText`（dark）；`--gs-gray-0` |

**暗色语义（照抄 `.dark` 块）**

| AgentSDR 语义 | 亮色取值 | 暗色取值 | 本项映射 |
|---|---|---|---|
| `bg-white-0` | `gray-0` #FFFFFF | `gray-950` #171717 | 页面/卡片底（暗色用 #171717，卡片用 #1C1C1C 以保留层级） |
| `bg-weak-50` | `gray-50` #F7F7F7 | `gray-800` #262626 | 弱面/表头/空态 chip |
| `bg-weak-25` | `gray-50` #F7F7F7 | `gray-900` #1C1C1C | 暗色容器底 |
| `bg-soft-200` | `gray-200` #EBEBEB | `gray-700` #333333 | 次级填充/轨道 |
| `stroke-soft-200` | `gray-200` #EBEBEB | `gray-800` #262626 | 1px 边框 |
| `text-strong-950` | `gray-950` #171717 | `gray-0` #FFFFFF | 主文字 |
| `text-sub-600` | `gray-600` #5C5C5C | `gray-400` #A3A3A3 | 次级文字 |
| `text-soft-400` | `gray-400` #A3A3A3 | `gray-500` #7B7B7B | 弱文字/图标（暗色不用于正文） |
| `text-disabled-300` | `gray-300` #D1D1D1 | `gray-600` #5C5C5C | 禁用文字 |

---

## 2. 品牌蓝与语义色

| AgentSDR token | OKLCH 原文 | Hex | 对比度（白字/黑字） | AntDV token |
|---|---|---|---|---|
| `--color-blue-500` | `oklch(55.50% 0.2449 266.68)` | `#335CFF` | 白 5.10 / 黑 4.12 | `colorPrimary` / `colorInfo`（light & dark 主行动） |
| `--color-blue-600` | `oklch(53.11% 0.2206 267.25)` | `#3559E9` | 白 5.59 / 黑 3.76 | 备用主色（hover 可选） |
| `--color-blue-700` | `oklch(47.07% 0.2134 266.52)` | `#2547D0` | 白 7.26 / 黑 2.89 | `colorPrimaryHover`（light） |
| `--color-blue-800` | `oklch(41.36% 0.1839 266.76)` | `#1F3BAD` | 白 9.18 / 黑 2.29 | `colorPrimaryActive`（light） |
| `--color-blue-400` | `oklch(63.60% 0.1945 264.29)` | `#4D82FF` | 白 3.53 / 黑 5.95 | `colorLink`（dark）/ 焦点环；**不用于白字按钮底色** |
| `--color-blue-200` | `oklch(87.13% 0.0627 264.17)` | `#C0D5FF` | — | `colorPrimaryBorder`（light） |
| `--color-blue-100` | `oklch(91.20% 0.0421 266.32)` | `#D5E2FF` | — | 选中底色（light） |
| `--color-blue-50` | `oklch(95.77% 0.0199 267.29)` | `#EBF1FF` | — | `colorPrimaryBg`（light）/ 徽章底 |
| `--color-error-500` | `oklch(64.71% 0.2288 22.47)` | `#FB3748` | 白 3.66 / 黑 5.74 | `colorError`（light） |
| `--color-error-600` | `oklch(61.39% 0.2142 22.34)` | `#E93544` | 白 4.15 / 黑 5.06 | `colorError`（dark）/ hover |
| `--color-error-400` | `oklch(70.98% 0.1839 17.96)` | `#FF6875` | 白 2.80 / 黑 7.49 | 暗色错误文字/图标 |
| `--color-warning-500` | `oklch(70.64% 0.1872 47.14)` | `#FA7319` | 白 2.79 / 黑 7.53 | `colorWarning`（light，仅图标/边框；白字不达 AA） |
| `--color-warning-600` | `oklch(65.12% 0.1737 46.95)` | `#E16614` | 白 3.44 / 黑 6.11 | 警告文字/深色底 |
| `--color-warning-400` | `oklch(79.78% 0.1320 53.13)` | `#FFA468` | 白 1.95 / 黑 10.76 | 暗色警告文字/图标 |
| `--color-success-500` | `oklch(71.39% 0.1762 153.08)` | `#1FC16B` | 白 2.36 / 黑 8.90 | `colorSuccess`（light，仅图标/边框） |
| `--color-success-600` | `oklch(66.41% 0.1630 153.13)` | `#1DAF61` | 白 2.85 / 黑 7.36 | 成功文字/深色底 |
| `--color-success-400` | `oklch(80.43% 0.1806 154.67)` | `#3EE089` | 白 1.72 / 黑 12.23 | 暗色成功文字/图标 |
| `--color-away-500` | `oklch(81.24% 0.1619 81.39)` | `#F6B51E` | 白 1.82 / 黑 11.55 | 提醒/等待徽章 |

**语义映射原则**

- 主行动只使用 `blue-500 #335CFF` 或 `blue-600 #3559E9`，白字；暗色也用 `#335CFF`（白字 5.10 达 AA），**不把 `blue-400` 当按钮底色**（白字仅 3.53）。
- 链接/焦点在暗色用 `blue-400 #4D82FF`（深底上 5.95 黑字对比，亮蓝可读）。
- success/warning 的 500 档只做图标、边框、浅底；需要文字时用 600 档或更深的语义色。错误 500 可做白字底（3.66，仅大字/图标），正文错误色用 600。
- 所有状态必须“文字 + 颜色/图标”，不只靠颜色。

---

## 3. 圆角

| AgentSDR token | 值 | 用途 | AntDV token | CSS 变量 |
|---|---|---|---|---|
| `--radius-10` | `.625rem` = 10px | 卡片、输入、次级按钮、分段控件 | `borderRadius` / `borderRadiusSM` | `--gs-radius-10` |
| `--radius-20` | `1.25rem` = 20px | 大容器、Modal、Drawer、弹层 | `borderRadiusLG` | `--gs-radius-20` |
| 主按钮（题目规格） | `9999px` | 主 CTA / 药丸按钮 | 组件类 `.gs-btn-primary`（或 Button token 的 `borderRadius: 9999`，仅主按钮） | `--gs-radius-pill` |
| 徽章/头像 | `9999px` | Badge、Avatar、Tag | `borderRadiusSM` 不适用；用类/组件 token | `--gs-radius-pill` |

> AgentSDR 的 `rounded-xl`（12px）/`rounded-2xl`（16px）是 Tailwind 默认值，不是 token。本项目按题目规格收敛到 10/20/9999 三档；卡片统一 10px，弹层统一 20px，主按钮 9999px。不要新增 12/16px 档。

---

## 4. 字体与排版

**字体栈（照抄 `:root`）**

```css
--font-sans: system-ui, -apple-system, "Segoe UI", Arial, Helvetica, sans-serif;
```

AntDV：`fontFamily: "system-ui, -apple-system, 'Segoe UI', Arial, Helvetica, sans-serif"`；中文场景由系统字体回退。

**字号 token（照抄 `@theme` 342–477 行）**

| 语义 | token | 字号 / 行高 / 字距 / 字重 | 本项目用法 |
|---|---|---|---|
| 页面主标题 | `--text-title-h1` | 3.5rem / 4rem / -0.01em / 500 | 登录品牌标题（大屏） |
| 区块标题 | `--text-title-h4` | 2rem / 2.5rem / -0.005em / 500 | 驾驶舱模块标题（按页面缩放） |
| 卡片标题 | `--text-title-h6` | 1.25rem / 1.75rem / 0 / 500 | KPI/卡片标题 |
| 标签大 | `--text-label-lg` | 1.125rem / 1.5rem / -0.015em / 500 | 主按钮/关键标签 |
| 标签中 | `--text-label-md` | 1rem / 1.5rem / -0.011em / 500 | 表单 label |
| 标签小 | `--text-label-sm` | .875rem / 1.25rem / -0.006em / 500 | 按钮、表格表头、徽章 |
| 标签超小 | `--text-label-xs` | .75rem / 1rem / 0 / 500 | 辅助标签 |
| 段落大 | `--text-paragraph-lg` | 1.125rem / 1.5rem / -0.015em / 400 | 页面说明段落（题目“段落 1.125rem/1.5 行高”） |
| 段落中 | `--text-paragraph-md` | 1rem / 1.5rem / -0.011em / 400 | 正文 |
| 段落小 | `--text-paragraph-sm` | .875rem / 1.25rem / -0.006em / 400 | 表格/卡片辅助文字 |
| 段落超小 | `--text-paragraph-xs` | .75rem / 1rem / 0 / 400 | 时间戳/脚注 |
| 小标题 | `--text-subheading-*` | 1rem/1.5rem、.875rem/1.25rem、.75rem/1rem；字距 +0.06em/+0.04em；500 | 分组小标题/全大写标签 |
| 文档标签/段落 | `--text-doc-label` / `--text-doc-paragraph` | 1.125rem / 2rem / -0.015em / 500 或 400 | 长篇说明（按需） |

**AntDV 映射**

| AntDV token | 值 | 说明 |
|---|---|---|
| `fontSize` | 14 | 控件/表格基准 = `label-sm` |
| `fontSizeSM` | 12 | 辅助 |
| `fontSizeLG` | 16 | 大控件 |
| `fontSizeHeading1`…`Heading5` | 按 title-h1…h5 递减 | 标题字重 500 |
| `lineHeight` | 1.4286（20/14） | 控件 |
| `fontWeightStrong` | 500 | 标题/强调 |
| `colorTextHeading` | `#171717`（light）/ `#FFFFFF`（dark） | 标题 |

> 页面段落用 `.gs-prose` 类设置为 `1.125rem / 1.5rem / -0.015em / 400`；不要用 AntDV 全局 `fontSize:18` 把表格/表单一起放大。

---

## 5. 阴影

| AgentSDR token | 值（原文） | 用途 | 本项目 CSS 变量 |
|---|---|---|---|
| `--shadow-regular-xs` | `0 1px 2px 0 #0a0d1408` | 按钮/小卡/描边卡 | `--gs-shadow-xs` |
| `--shadow-regular-sm` | `0 2px 4px #1b1c1d0a` | 悬浮小卡 | `--gs-shadow-sm` |
| `--shadow-regular-md` | `0 16px 32px -12px #0e121b1a` | 弹层/下拉 | `--gs-shadow-md` |
| `--shadow-custom-xs` | `0 0 0 1px rgba(51,51,51,.04), 0 4px 8px -2px rgba(51,51,51,.06), 0 2px 4px rgba(51,51,51,.04), 0 1px 2px rgba(51,51,51,.04), inset 0 -1px 1px -0.5px rgba(51,51,51,.06)` | 卡片（带 1px 描边感） | `--gs-shadow-card`（可与真实 border 二选一） |
| `--shadow-custom-md` | 见 globals.css 513 行 | 大卡片/面板 | 仅在需要时使用，不新增近似值 |
| `--shadow-custom-lg` | 见 515 行 | 大弹层 | 不默认使用 |
| `--shadow-tooltip` | `0 12px 24px 0 #0e121b0f, 0 1px 2px 0 #0e121b08` | tooltip | `--gs-shadow-tooltip` |
| `--shadow-button-primary-focus` | `0 0 0 2px var(--color-bg-white-0), 0 0 0 4px var(--color-primary-alpha-10)` | 主按钮焦点 | `--gs-shadow-focus` |

**暗色值**：AgentSDR 在 `.dark` 将 `complex-*` 的彩色阴影降为透明/黑（705 行起）。本项目：

```css
.dark {
  --gs-shadow-xs: 0 1px 2px 0 rgba(0, 0, 0, 0.45);
  --gs-shadow-sm: 0 2px 4px rgba(0, 0, 0, 0.5);
  --gs-shadow-md: 0 16px 32px -12px rgba(0, 0, 0, 0.65);
  --gs-shadow-card: 0 1px 2px 0 rgba(0, 0, 0, 0.45);
  --gs-shadow-tooltip: 0 12px 24px 0 rgba(0, 0, 0, 0.55);
}
```

**AntDV**：`boxShadow` = `--gs-shadow-xs`；`boxShadowSecondary` = `--gs-shadow-md`；`boxShadowTertiary` = `--gs-shadow-sm`。暗色由上面的 `.dark` 值覆盖（通过 `useAntdDesignTokens`/ConfigProvider computed 选择）。

---

## 6. 间距与布局

AgentSDR 没有自定义 spacing token，使用 Tailwind 默认 **4px 基准**（`0.25rem`）。以下为从参考组件提取的实际用法：

| 语义 | 值 | 来源/用途 |
|---|---|---|
| 基准单位 | 4px | Tailwind spacing scale |
| 页面最大宽度 | 1280px | 现有 `PageContainer` / growth 栏宽 |
| 页面内边距 | 24px | 现有页面与参考 `p-5`/`px-6` |
| 卡片内边距 | 20–24px | `Frame` `p-4 sm:p-5`；本项目统一 24px（紧凑 20px） |
| 卡片网格间距 | 16–20px | `gap-4` / `gap-5` |
| 表单字段间距 | 16px | `gap-4` |
| 表单内 label→控件 | 8px | `gap-2` |
| 按钮组间距 | 8–12px | `gap-2` / `gap-3` |
| 分区间距 | 24–32px | `gap-5` / `gap-6` |
| 空状态 | `px-6 py-16`（紧凑 `px-4 py-8`） | `EmptyState` |
| 表格行高 | 44–48px | AntDV `middle` + 12px 纵向 padding |
| 触控目标 | ≥40px | 12 条准则第 11 条 |

**AntDV**：`controlHeight: 40`、`controlHeightLG: 44`、`controlHeightSM: 32`；`padding: 16`、`paddingLG: 24`、`paddingSM: 12`、`margin: 16`、`marginLG: 24`。

---

## 7. AntDV ConfigProvider 完整映射（P1 直接采用）

### 7.1 亮色

| AntDV token | 值 | 来源 |
|---|---|---|
| `colorPrimary` | `#335CFF` | blue-500 |
| `colorPrimaryHover` | `#2547D0` | blue-700（AgentSDR hover=primary-darker） |
| `colorPrimaryActive` | `#1F3BAD` | blue-800 |
| `colorPrimaryBg` | `#EBF1FF` | blue-50 |
| `colorPrimaryBorder` | `#C0D5FF` | blue-200 |
| `colorInfo` | `#335CFF` | blue-500 |
| `colorLink` | `#335CFF` | blue-500 |
| `colorLinkHover` | `#2547D0` | blue-700 |
| `colorSuccess` | `#1FC16B` | green-500（图标/边框；文字用 #1DAF61） |
| `colorWarning` | `#FA7319` | orange-500（图标/边框；文字用 #E16614） |
| `colorError` | `#FB3748` | red-500（图标/边框；文字用 #E93544） |
| `colorText` | `#171717` | gray-950 |
| `colorTextHeading` | `#171717` | gray-950 |
| `colorTextSecondary` | `#5C5C5C` | gray-600 |
| `colorTextTertiary` | `#7B7B7B` | gray-500 |
| `colorTextQuaternary` | `#A3A3A3` | gray-400 |
| `colorTextDisabled` | `#D1D1D1` | gray-300 |
| `colorBgBase` | `#FFFFFF` | gray-0 |
| `colorBgContainer` | `#FFFFFF` | gray-0 |
| `colorBgElevated` | `#FFFFFF` | gray-0 |
| `colorBgLayout` | `#F7F7F7` | gray-50 |
| `colorBgSpotlight` | `#171717` | gray-950（tooltip） |
| `colorBorder` | `#EBEBEB` | gray-200 |
| `colorBorderSecondary` | `#F5F5F5` | gray-100 |
| `colorSplit` | `#F5F5F5` | gray-100 |
| `colorFillSecondary` | `#F5F5F5` | gray-100 |
| `colorFillTertiary` | `#F7F7F7` | gray-50 |
| `colorFillQuaternary` | `#FAFAFA` | 由 gray-50 提亮（仅表格 hover） |
| `borderRadius` | `10` | radius-10 |
| `borderRadiusLG` | `20` | radius-20 |
| `borderRadiusSM` | `10` | 两档收敛，不新增 8/6 |
| `controlHeight` | `40` | 参考 h-10 |
| `controlHeightLG` | `44` | 大按钮 |
| `controlHeightSM` | `32` | 小按钮 |
| `fontFamily` | system-ui 栈 | §4 |
| `fontSize` | `14` | label-sm |
| `lineHeight` | `1.4286` | 20/14 |
| `fontWeightStrong` | `500` | 标题 500 |
| `boxShadow` | `0 1px 2px 0 rgba(10,13,20,0.031)` | regular-xs |
| `boxShadowSecondary` | `0 16px 32px -12px rgba(14,18,27,0.10)` | regular-md |
| `boxShadowTertiary` | `0 2px 4px rgba(27,28,29,0.039)` | regular-sm |
| `wireframe` | `false` | 保持实心卡片质感 |

### 7.2 暗色

| AntDV token | 值 | 来源 |
|---|---|---|
| `colorPrimary` | `#335CFF` | blue-500（白字 5.10，AA） |
| `colorPrimaryHover` | `#4D82FF` | blue-400（暗色 hover 提亮） |
| `colorPrimaryActive` | `#2547D0` | blue-700 |
| `colorPrimaryBg` | `rgba(51,92,255,0.16)` | blue-alpha-16 |
| `colorPrimaryBorder` | `rgba(51,92,255,0.24)` | blue-alpha-24 |
| `colorInfo` | `#335CFF` | blue-500 |
| `colorLink` | `#4D82FF` | blue-400（深底可读） |
| `colorLinkHover` | `#97BAFF` | blue-300 |
| `colorSuccess` | `#3EE089` | green-400 |
| `colorWarning` | `#FFA468` | orange-400 |
| `colorError` | `#FF6875` | red-400 |
| `colorText` | `#FFFFFF` | gray-0 |
| `colorTextHeading` | `#FFFFFF` | gray-0 |
| `colorTextSecondary` | `#A3A3A3` | gray-400 |
| `colorTextTertiary` | `#7B7B7B` | gray-500（仅非关键；正文不用） |
| `colorTextQuaternary` | `#5C5C5C` | gray-600 |
| `colorTextDisabled` | `#5C5C5C` | gray-600 |
| `colorBgBase` | `#171717` | gray-950 |
| `colorBgContainer` | `#1C1C1C` | gray-900 |
| `colorBgElevated` | `#262626` | gray-800 |
| `colorBgLayout` | `#171717` | gray-950 |
| `colorBgSpotlight` | `#FFFFFF` | gray-0（tooltip 反色） |
| `colorBorder` | `#262626` | gray-800 |
| `colorBorderSecondary` | `#333333` | gray-700 |
| `colorSplit` | `#262626` | gray-800 |
| `colorFillSecondary` | `#262626` | gray-800 |
| `colorFillTertiary` | `#1C1C1C` | gray-900 |
| `colorFillQuaternary` | `#171717` | gray-950 |
| `borderRadius` / `LG` / `SM` | `10` / `20` / `10` | 同亮色 |
| 字体/间距/阴影 | 同亮色，阴影用 §5 暗色值 | — |

> 通过 `theme.darkAlgorithm` + 上述 token 覆盖实现；不要只改 `colorBgBase` 而让 AntDV 自行推导出彩色灰。

---

## 8. 组件质感规格（从参考提取）

| 组件 | 规格 |
|---|---|
| 卡片 | 白底 `colorBgContainer` + 1px `colorBorder` + `--gs-shadow-card`；圆角 10；内边距 24（紧凑 20） |
| KPI 卡 | 同卡片；图标/标签在上，数值 24px/500，说明性副文案 12–14px；右上角 ⓘ tooltip（AntDV Tooltip）；整卡可点击时 hover 边框转 `colorPrimaryBorder` |
| 主按钮 | `#335CFF` 底 + 白字 + 9999px 圆角 + `--gs-shadow-xs`；hover `#2547D0`；focus 用 `--gs-shadow-focus`；高度 40 |
| 次按钮 | 白底/透明 + 1px `colorBorder`；圆角 10；hover `colorFillTertiary` |
| 危险按钮 | `#E93544` 底 + 白字（light）；暗色 `#FF6875` 底 + `#171717` 字（对比 7.49） |
| 输入/选择 | 白底 + 1px `colorBorder` + 圆角 10；focus 1.4px `#335CFF`（参考 `--shadow-custom-input-active`） |
| 徽章 | 药丸形；浅底 + 深字 + 可选圆点；状态同时有文字 |
| 空状态 | 40px 图标 chip（弱底 + 1px 描边）+ 一句话标题 + 一句说明 + 主 CTA；居中；`px-6 py-16`（紧凑 `px-4 py-8`） |
| 表格 | 表头 14px/500、`colorTextSecondary`；行 hover `colorFillTertiary`；1px `colorSplit`；空态用空状态组件，不只写“暂无数据” |
| 侧边栏分组 | 工作空间 / 获客 / 线索 / 活动 / 增长 / 设置；组标题 12px/500 大写感（中文不加字距也可）；组间距 24；激活项用 `colorPrimaryBg` + `colorPrimary` |
| 顶栏 | 保留 Vben 搜索（⌘K）与主题按钮；不覆盖 `@vben/layouts` 内部类 |

---

## 9. 验收要点（P1）

1. `apps/web/src/app.vue` 的 `brandTokens` 改为本表 7.1/7.2；删除绿色品牌常量。
2. `apps/web/src/preferences.ts` 的 `theme.colorPrimary` 改为 `hsl(228 100% 60%)`（#335CFF）；保留 `themeToggle: true`，不删按钮。
3. `apps/web/src/styles/gainos.css` 的 `--gs-*` 双主题值按本表更新；保留现有页面使用的兼容别名（`--gs-primary`、`--gs-muted`、`--gs-mono`、`--gs-fg-1/3` 等），避免大范围改页面变量。
4. 暗色必须同时有 `.dark` 值；每一处新增颜色/阴影/边框都写两套。
5. 侧边栏分组只通过菜单数据/布局提供的能力实现，不写全局 CSS 覆盖 `@vben/layouts` 内部类名。
6. 对比度：正文 ≥4.5:1；大字号/图标 ≥3:1；不把 `#7B7B7B` 用在暗色正文。

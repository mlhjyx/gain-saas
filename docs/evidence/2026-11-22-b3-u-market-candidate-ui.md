# B3-U 公司市场候选 UI+B（正式前端集成）

> 正式前端集成的工程证据，不是真实权限、费用、持久化、部署或完整体验验收。当前 head 以 PR 实际提交为准；本文件随 PR 更新。

## 基线与输入

- 正式 parent：`43f39c2dbe538a660bb8d5616a898285a77e0fbe`（SaaS 安全底座）。
- 私有 UI 候选：`f4dacb5c5b59c822e04e6084f20208e1cd272ca8`，仅按原 17 路径业务范围复用，未整文件覆盖新 main。
- 文案与边界：P 身份文案与首期业务验收 handover `45eda079057d052c259f7310dee414da3b1eb470631a2d570e85e120ed230fa4`；T UI+B/身份落地边界 `b8ae60373c1a4f13b6d4dda2377518bb554a52d07adf8b6c9e21a7425c3af819`；D 静态体验矩阵 `7fa84c0bf037a7eab6d0297ddf10b5294a6bc831bd3d1e566d6ecdeaa6796c28`。显示分类不是新 wire 码，不据此改权限或状态策略。

## 范围

- 原 17 路径：公司更多菜单进入市场候选面板，读取当前/历史文档、依据可用性、支持与反证、双国家及未知、原始提议与用户纠正；准备、执行、查询、恢复为明确动作；反馈四动作固定原 idempotency-key/body/所见修订；历史只读。
- `apps/web/src/api/request.ts`：只对**当前 client 的初始 prepare POST、数值 400、精确码 `VALIDATION_ERROR`/`NO_APPROVED_CLAIMS`、精确 `/companies/{UUID}/market-candidate-generations` 路径**抑制全局 toast，由面板显示行内错误；cold-read/execute/recover/feedback/5xx/域 403 等仍保留同源 toast，不靠中文标题子串判断。市场候选请求不再受旧“授权对接”中文分支影响，旧页面行为不变。
- 被动恢复：仅在初始 prepare 未收到成功响应、同 epoch/context、数值 400 且精确上述两码时出现；面板发出 `{companyId,destination:'facts'|'documents'}`，父组件校验同一公司/上下文后调用既有 facts/claims 或 seller-documents 弹层的**只读模式**（隐藏上传/重试/删除/手动事实/批量审批/冲突裁决，保留读取、下载与搜索 GET）。打开期间候选 hook 保持挂载但隐藏/不可聚焦，返回后焦点回到实际触发按钮；只 GET 同公司只读端点，无写、上传、审批、understand、prepare、execute 或换 nonce。
- 身份文案：显示服务端可信 `userCopy`；无安全 copy 时用中性双语回退，不回显 `error.message`/`meta.engineMessage`；个人断言改为中性阻断提示。初始 prepare 的两码 400 使用 P v3 canonical 中英 title/why/next（不称买家画像、不说公司无任何 Claim、不要求修正不存在的标红字段）。只有 SaaS 确认的 `AUTH_REQUIRED`/`SESSION_EXPIRED`/`NOT_A_MEMBER`/`WORKSPACE_DISABLED` 才粘滞阻断；HTTP 403/404、引擎 `SCOPE_REQUIRED`/`FORBIDDEN`、同名 code 或后缀都不判个人无权，服务 502 后动作保持可重试。身份 shared/BFF 三接缝未改，仍待 Root 精确 freeze。

## 未做与交 T/P/D

- 未修改登录/登出、状态码、domain403 例外、Grant、预算或重试策略。
- 未修改 `packages/shared/src/errors.ts`、`apps/server/src/bff/engine-http.ts`、`apps/server/src/bff/bff.test.ts` 三接缝；服务授权英文文案与个人读/写/反馈可信归属仍缺既有 wire 来源，前端保持中性回退，待 Root 精确 freeze 后实现。
- 未做真实 RBAC/跨租户、真实冷读、费用/持久化、systemd/部署或真实栈 UX 验收；mock 通过不等于实权或产品结果。

## 验证

（以下为本地当前 head 的实际命令与结果；全量 e2e 由 PR CI 复核。）

- `corepack pnpm --filter @vben/web-antd typecheck`：通过。
- `corepack pnpm lint:terms`：通过。
- `corepack pnpm lint:date`：通过。
- `corepack pnpm --filter @vben/web-antd build`：通过。
- 临时 strict tsconfig 对三个 market-candidates spec + fixture 做 `tsc --noEmit`：通过。
- `corepack pnpm exec playwright test apps/web/e2e/market-candidates-read.spec.ts --project=desktop --grep "zh-CN-light-desktop"`：16/16 通过；V01 覆盖两码 400 的 facts/documents 被动 GET、单一可见 dialog、面板隐藏/焦点返回与两码无 toast。
- `corepack pnpm exec playwright test apps/web/e2e/market-candidates-generation.spec.ts --project=desktop --grep "zh-CN-light-desktop"`：19/19 通过；V07 覆盖服务 502/未知 502/预算拒绝的同源 toast、两码 400 静默行内、无 userCopy 时 toast 与行内均中性且不含 raw；服务 502 不粘滞禁用 prepare，可信租户拒绝才禁用。
- `corepack pnpm exec playwright test apps/web/e2e/market-candidates-read.spec.ts --project=desktop --grep "zh-CN-light-narrow"`：16/16 通过；窄屏覆盖两码恢复、单一可见 dialog、焦点返回与只读 GET。
- `corepack pnpm exec playwright test apps/web/e2e/market-candidates-feedback.spec.ts --project=desktop --grep "zh-CN-light-desktop"`：14/14 通过；V14 覆盖在途 busy 时遮罩点击/Tab/Shift+Tab 焦点仍在反馈对话框内，Escape 不丢弃冻结请求；V16 使用可信租户拒绝而非 SCOPE_REQUIRED 个人化。
- `corepack pnpm exec playwright test apps/web/e2e/market-candidates-generation.spec.ts --project=desktop --grep "en-US-light-desktop.*V17 only explicit"`：1/1 通过；新增 focusout 兜底后，重渲染丢失焦点的面板会回到关闭按钮/面板内，不把焦点留在 body；反馈对话框打开时边界收敛到该对话框。
- 本地未跑全量 392 格：全量 e2e 交 PR CI；本机仅跑受影响单格。CI 结果以 PR 检查为准。
- 集成中发现新 main 的命令面板 `Enter` 全局监听会在任意焦点触发无关导航（`apps/web/src/components/gainos/command-palette.vue`）；市场面板已对自身键盘事件 `stopPropagation` 隔离，未改全局组件。该全局缺陷仍影响其他页面，交 T/P/D 判断是否另行修复。
- 真实权限、费用、持久化、部署与 8 分类实栈证据：NOT_RUN。

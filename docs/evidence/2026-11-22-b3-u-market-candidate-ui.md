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
- 身份文案：BFF 服务身份 401/403→502 分支改为按 `Accept-Language` 输出中性双语 P 文案（服务授权校验暂未通过 / Service authorization could not be verified），保留原 code/502/不登出，不再承诺保留、费用、不会重执行或稍后重试。显示服务端可信 `userCopy`；无安全 copy 时用中性双语回退，不回显 `error.message`/`meta.engineMessage`；个人断言改为中性阻断提示。初始 prepare 的两码 400 使用 P v3 canonical 中英 title/why/next（不称买家画像、不说公司无任何 Claim、不要求修正不存在的标红字段）。只有 SaaS 确认的 `AUTH_REQUIRED`/`SESSION_EXPIRED`/`NOT_A_MEMBER`/`WORKSPACE_DISABLED` 才粘滞阻断；HTTP 403/404、引擎 `SCOPE_REQUIRED`/`FORBIDDEN`、同名 code 或后缀都不判个人无权，服务 502 后动作保持可重试。
- 迟到隔离：`loadClaims`/`loadCompanyOverview`/`loadConflicts`/`loadDocuments`/`searchDocuments` 在请求时捕获 company+epoch（搜索另加 seq+query），响应应用、错误与 loading 清理都校验仍是当前；旧公司或旧 query 的迟到响应不会写入新上下文。
- 执行预派发：BFF 在 engine.call 前拒绝的 `EXECUTION_BUDGET_QUOTE_UNAVAILABLE`/`_QUOTE_INVALID`/`_GRANT_FAILED` 保持 PREPARED、重置 attempted 并允许用户显式重试；只有真正未知才 RESULT_UNKNOWN。
- 焦点：详情容器（tabindex=-1）内 Tab 交给原生顺序；反馈对话框打开时 focusout 边界收敛到对话框，busy 无控件时 Tab 仍留在 dialog；隐藏市场面板 inert/aria-hidden。

## 未做与交 T/P/D

- 未修改登录/登出、状态码、domain403 例外、Grant、预算或重试策略。
- 已修改 `apps/server/src/bff/engine-http.ts` 与 `apps/server/src/bff/bff.test.ts`（服务身份中性双语）；`packages/shared/src/errors.ts` 未改。个人读/写/反馈可信归属仍缺既有 wire 来源，前端保持中性回退，待 Root 精确 freeze 后实现。
- 依赖说明：`apps/web/src/views/leads/DecisionMakerCard.vue` 仍用旧标题子串“授权对接”判断 scopeHint；因不在本轮冻结路径内未改，BFF 新标题下该附加提示会不再显示（错误本身仍有中性 copy），交 T/P/D 决定是否另开路径。
- 未做真实 RBAC/跨租户、真实冷读、费用/持久化、systemd/部署或真实栈 UX 验收；mock 通过不等于实权或产品结果。

## 验证

（以下为本地当前 head 的实际命令与结果；全量 e2e 由 PR CI 复核。）

- `corepack pnpm --filter @vben/web-antd typecheck`：通过。
- `corepack pnpm lint:terms`：通过。
- `corepack pnpm lint:date`：通过。
- `corepack pnpm --filter @vben/web-antd build`：通过。
- 临时 strict tsconfig 对三个 market-candidates spec + fixture 做 `tsc --noEmit`：通过。
- `apps/server`：`tsc -p tsconfig.json --noEmit` 通过（先 `db:generate` + `@gain-saas/ops-pg build`）；`vitest run src/bff/bff.test.ts` 15/15 通过。
- 反证：临时移除 `loadClaims` company/epoch 守卫后 V01b 变红；移除 `searchDocuments` 守卫后 V01c 变红；临时关闭两码 toast 抑制后 V01 的 MutationObserver 变红，随后恢复。
- `corepack pnpm exec playwright test apps/web/e2e/market-candidates-read.spec.ts --project=desktop --grep "zh-CN-light-desktop"`：18/18 通过；V01 覆盖两码 400 的 facts/documents 被动 GET、只读模式、单可见 dialog、面板隐藏/焦点返回、MutationObserver 证明两码无 toast；V01b 覆盖旧公司迟到 claims/overview；V01c 覆盖旧公司/旧 query 迟到资料检索不覆盖当前。
- `corepack pnpm exec playwright test apps/web/e2e/market-candidates-generation.spec.ts --project=desktop --grep "zh-CN-light-desktop"`：19/19 通过；V07 覆盖服务 502/未知 502/预算拒绝的同源 toast、两码 400 静默行内、无 userCopy 时 toast 与行内均中性且不含 raw；服务 502 不粘滞禁用 prepare，可信租户拒绝才禁用。
- `corepack pnpm exec playwright test apps/web/e2e/market-candidates-read.spec.ts --project=desktop --grep "zh-CN-light-narrow"`：18/18 通过；窄屏同覆盖。
- `corepack pnpm exec playwright test apps/web/e2e/market-candidates-feedback.spec.ts --project=desktop --grep "zh-CN-light-desktop"`：14/14 通过；V12 四类反馈逐项校验 POST body.action 与卡片 pill 文案；V14 覆盖在途 busy 时遮罩点击/Tab/Shift+Tab 焦点仍在反馈对话框内，Escape 不丢弃冻结请求；V16 使用可信租户拒绝而非 SCOPE_REQUIRED 个人化。
- `corepack pnpm exec playwright test apps/web/e2e/market-candidates-generation.spec.ts --project=desktop --grep "en-US-light-desktop.*V17 only explicit"`：1/1 通过；新增 focusout 兜底后，重渲染丢失焦点的面板会回到关闭按钮/面板内，不把焦点留在 body；反馈对话框打开时边界收敛到该对话框。
- 本地未跑全量 392 格：全量 e2e 交 PR CI；本机仅跑受影响单格。CI 结果以 PR 检查为准。
- 集成中发现新 main 的命令面板 `Enter` 全局监听会在任意焦点触发无关导航（`apps/web/src/components/gainos/command-palette.vue`）；市场面板已对自身键盘事件 `stopPropagation` 隔离，未改全局组件。该全局缺陷仍影响其他页面，交 T/P/D 判断是否另行修复。
- 真实权限、费用、持久化、部署与 8 分类实栈证据：NOT_RUN。

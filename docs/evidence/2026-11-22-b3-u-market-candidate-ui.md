# B3-U 公司市场候选 UI+B（正式前端集成）

> 正式前端集成的工程证据，不是真实权限、费用、持久化、部署或完整体验验收。当前 head 以 PR 实际提交为准；本文件随 PR 更新。

## 基线与输入

- 正式 parent：`43f39c2dbe538a660bb8d5616a898285a77e0fbe`（SaaS 安全底座）。
- 私有 UI 候选：`f4dacb5c5b59c822e04e6084f20208e1cd272ca8`，仅按原 17 路径业务范围复用，未整文件覆盖新 main。
- 文案与边界：P 身份文案、T UI/BFF 合同、D 静态体验矩阵及首期业务验收 UI+B 节；显示分类不是新 wire 码，不据此改权限或状态策略。

## 范围

- 原 17 路径：公司更多菜单进入市场候选面板，读取当前/历史文档、依据可用性、支持与反证、双国家及未知、原始提议与用户纠正；准备、执行、查询、恢复为明确动作；反馈四动作固定原 idempotency-key/body/所见修订；历史只读。
- `apps/web/src/api/request.ts`：新增请求级 `errorToastHandledInline` 配置，市场候选请求由面板独占行内错误通知；不按文案语言/错误码猜通知归属，不改变其他页面。
- 被动恢复：面板提供“查看企业事实”显式入口，调用同公司既有 facts/offerings/claims 只读弹层；打开期间市场面板保持挂载但隐藏，关闭后回到触发点。未增加写、审批、上传、understand、prepare、execute 或换 nonce。
- 身份文案：显示服务端可信 `userCopy`；无安全 copy 时用中性双语回退，不回显 `error.message`/`meta.engineMessage`；`scopeDenied` 个人断言改为中性阻断提示。前端不按 HTTP 状态、同名 code/后缀或 member/admin 猜个人无权。

## 未做与交 T/P/D

- 未修改 `packages/shared/src/errors.ts`、BFF `engine-http.ts`/`bff.test.ts`、登录/登出、状态码、domain403 例外、Grant、预算或重试策略。
- 服务授权英文文案仍由服务端当前分支固定中文；个人读/写/反馈三类可信归属目前没有既有 wire 来源，前端对其保持中性回退。两项需 T/P/D 另冻来源后再实现。
- 未做真实 RBAC/跨租户、真实冷读、费用/持久化、systemd/部署或真实栈 UX 验收；mock 通过不等于实权或产品结果。

## 验证

（以下为本地当前 head 的实际命令与结果；全量 e2e 由 PR CI 复核。）

- `corepack pnpm --filter @vben/web-antd typecheck`：通过。
- `corepack pnpm lint:terms`：通过。
- `corepack pnpm lint:date`：通过。
- `corepack pnpm --filter @vben/web-antd build`：通过。
- `corepack pnpm exec playwright test apps/web/e2e/market-candidates-read.spec.ts --project=desktop --grep "zh-CN-light-desktop"`：16/16 通过。
- `corepack pnpm exec playwright test apps/web/e2e/market-candidates-generation.spec.ts --project=desktop --grep "zh-CN-light-desktop"`：19/19 通过（含 V07 服务文案/中性阻断、同公司 facts 往返、无 userCopy 中性回退）。
- `corepack pnpm exec playwright test apps/web/e2e/market-candidates-generation.spec.ts --project=desktop --grep "zh-CN-light-narrow"`：19/19 通过。
- `corepack pnpm exec playwright test apps/web/e2e/market-candidates-feedback.spec.ts --project=desktop --grep "zh-CN-light-desktop"`：14/14 通过。
- 本地未跑全量 392 格：全量 e2e 交 PR CI；本机仅跑受影响单格。CI 结果以 PR 检查为准。
- 集成中发现新 main 的命令面板 `Enter` 全局监听会在任意焦点触发无关导航（`apps/web/src/components/gainos/command-palette.vue`）；市场面板已对自身键盘事件 `stopPropagation` 隔离，未改全局组件。该全局缺陷仍影响其他页面，交 T/P/D 判断是否另行修复。
- 真实权限、费用、持久化、部署与 8 分类实栈证据：NOT_RUN。

# 前端发布与页面级回退演练（P5b-24）

> 生命周期：`DRAFT`
> 适用：开发预览、托管发布和回退指引。真实演练单独记录。
> 生命周期依据：回退步骤与 redirect 核对器已入库；首次真实回退演练待下一次前端发版后执行（2026-11-09）。

## 1. 发布形态

租户 SPA 从 `apps/web` 构建。运行在 systemd 托管的 SaaS 服务上；核对当前发布入口、制品和迁移。Web 静态产物与 server 版本可以单独采用：只更换 server 时要明确哪份 SPA 保留。实际发布在已批准的窗口切换版本化入口。

### 本机预览与验证

- 从自己的隔离工作树用 5667 做 HMR，用户验收用 `pnpm preview:web` 构建到 5666。`vite preview` 的 API 代理指向本机 SaaS；使用受管服务的登录态和数据时遵循验收范围。现行发布端口留给 systemd。前端界面由用户在 5666 验收通过，再进入 PR、CI、合并和部署。
- 在需要运行前端的工作树通过已批准的本机配置准备 `apps/web/.env*`。Vben 把 API 地址写入 `dist/_app-config-*.js`；核对 API 前缀并在配置改动后重建。dev 和 preview 的样式类生成可能不同，最终用生产构建验收。
- 本地按受影响页面跑 Playwright 定向用例；先确认默认预览端口的进程归属，冲突时改用 `GAINOS_E2E_PORT`，限时用 Playwright `--global-timeout`。截图和扫描可能写 `docs/evidence/ui-restyle/{antd-system,pass2,pass3}/`，先核对本任务范围再处理。
- 打开真实上线入口前记录回退制品、服务端/前端版本、迁移兼容性。切换后核对 readiness、目标页面和历史深链，分别回读 Web 和 Worker 采用情况。

## 2. 页面级回退（目标 <10 分钟）

1. 定位问题 PR：`git log --oneline -- apps/web/src/views/<page>`；确认其 squash 提交。
2. 从核验后的主线在独立工作树开 revert 分支：`git revert <squash-sha>`（一个 PR 一个 revert，不夹带其它改动）。
3. 通过独立审查、CI 和授权后合并；部署窗口按当前 service 入口采用新制品。若回到已保留的制品版本，先确认其对应 SPA、server 与数据库状态。
4. 验证清单：
   - 目标页面恢复旧行为；`pnpm exec playwright test e2e/` 全绿（含 a11y 抽样）；
   - 被该 PR 触及的深链仍可用（见 §3）；
   - 若 PR 含后端迁移：**前端回退不等于数据回退**，先确认迁移是否 additive（本仓迁移要求 additive；破坏性迁移必须单独评审）。
5. 把 revert SHA、验证输出贴进事故记录。

演练要求：每个发布列车的第一个前端 PR 合并后，在 staging（或本地 preview）做一次「revert → 构建 → 冒烟」的空跑并记录耗时；连续两个版本达标后可降为季度演练。

## 3. 历史深链（redirect ≥2 个发布版本）

`apps/web/src/router/routes/modules/legacy.ts` 维护被删除/合并路由的 redirect；`scripts/check-legacy-redirects.mjs` 在测试链里核对每个 `to` 命中已定义路径（含 `/settings` 这类父级+子路由组合），改动路由或 redirect 时它会在 CI 变红。删除一条 redirect 前先确认它已存在 ≥2 个发布版本（P5b-17/G10）。

## 4. 运营台衔接（tenant ↔ ops）

- 租户界面只调用 BFF（`/api/...` 同源），权限按 scope 收敛：读 `acquisition:read`、写/复核 `acquisition:review`、运营域 `ops:read/ops:write`；
- 运营动作（渠道治理、技能启停、判定复核）在运营台完成，站内通知走同一 `notifications` 通道（`SanctionsListStale` 等集成事件）；
- 新页面接入清单：路由模块 + `glossary.ts` 文案 + `lint:terms`/`lint:date` + a11y 抽样路径 + e2e mock 端点。

## 5. 本章（ch07）关闭口径

P5b 已交付：F0/F1/F2、QW 批、P5b-05（幂等）、P5b-06/08/09 主体/13/19/22。**未关闭项**：P5b-09 尾巴（跨公司 claims 队列，待引擎全局端点）、P5b-18 埋点（需 PostHog key 与数据合规确认）、P5b-21 移动端人工走查（需真人）、P5b-23 视觉回归基线（待渲染稳定性方案）。本章在以上四项完成前保持 `OPEN`，不以「大部分完成」关闭。

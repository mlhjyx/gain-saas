# 前端发布与页面级回退演练（P5b-24）

> 生命周期：`DRAFT`
> 生命周期依据：回退步骤与 redirect 核对器已入库；首次真实回退演练待下一次前端发版后执行（2026-11-09）。

## 1. 发布形态

gain-saas 前端由 `apps/web` 构建出静态产物，随 SaaS 服务一起由 systemd（`gain-saas-web`）托管；发布 = 合并到 `main` → CI 绿 → 部署窗口内 `pnpm build` + `systemctl restart gain-saas-web`。**没有独立的前端 CDN 灰度层**，所以「页面级回退」= 在 `main` 上 revert 对应 PR 并重新发布。

## 2. 页面级回退（目标 <10 分钟）

1. 定位问题 PR：`git log --oneline -- apps/web/src/views/<page>`；确认其 squash 提交。
2. 在 `main` 上开 revert 分支：`git revert <squash-sha>`（一个 PR 一个 revert，不夹带其它改动）。
3. CI 绿后合并；部署窗口内重新构建并 `systemctl restart gain-saas-web`。
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

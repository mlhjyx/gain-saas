# P4 对零：设置五页

> 范围：`/settings/members`、`/settings/suppressions`、`/settings/sources`、`/settings/privacy`、`/settings/audit`
> 不在范围：`/ops`、`/auth/login`、`/auth/register`（按 2026-11-22 指示不改造）
> 对照基线：`docs/evidence/ui-restyle/inventory.md` §2.14–§2.18

## 1. 导航收敛

- 删除 `SettingsShell` 内部的二级导航（`nav[aria-label="设置导航"]`）。
- 设置五页的导航统一由主侧栏「设置」分组承担；主侧栏本来就有这五项，去掉重复 nav 后：
  - 桌面：一个侧栏 + 一个内容区；
  - 移动端：主侧栏抽屉仍包含五项。
- `settings-shell.spec.ts` 改为从主侧栏「设置」分组进入审计页，并断言五项均可见。

## 2. 空状态（2 条真实路径）

| 页面 | 主路径 | 次路径 |
|---|---|---|
| members | 邀请成员（打开邀请弹窗） | 工作空间 `/workspace` |
| suppressions | 买家线索 `/leads` | 操作审计 `/settings/audit` |
| sources | 刷新（重新拉取可用渠道） | 操作审计 `/settings/audit` |
| privacy | 公司档案 `/companies` | 操作审计 `/settings/audit` |
| audit | 工作空间 `/workspace` | 成员与角色 `/settings/members` |

## 3. 健壮性修复（不改变 API/业务）

| 页面 | 问题 | 修复 |
|---|---|---|
| audit | 空响应时 `data.entries` 抛 `Cannot read properties of null` | `page = data ?? {entries:[],nextCursor:null,total:0}` |
| suppressions | 空响应时 `page.data` 抛 null 错误 | `rows = page?.data ?? []` |
| members | 空响应时 `data.members` 可能为 null | `?? { members: [], invitations: [] }` |
| sources | 空响应时 `available.length` 可能抛错 | `?? []` |
| privacy | 空响应时 `data.data` 可能抛错 | `data?.data ?? []` |

这些修复只影响空响应的展示（转为空态），不改变成功响应、请求方法/路径或业务判断。

## 4. 未改动项

- 所有表单字段、默认值、校验规则、错误文案：未改。
- 所有 API 方法/路径/触发时机：未改。
- 所有权限点/角色判断：未改。
- 所有既有 locales key/value：未改；仅新增 `gainos.members.emptyTitle`（中英文同步）。
- 登录/注册/ops：未触碰。

## 5. 验证

- `pnpm --filter @vben/web-antd typecheck` ✅
- `pnpm --filter @vben/web-antd build` ✅
- `pnpm lint:terms` ✅、`pnpm lint:date` ✅
- `settings-shell` / `a11y` / `zero-jargon` / `responsive` ✅
- 截图：`p4-{members,suppressions,sources,privacy,audit}-{light,dark}.png`

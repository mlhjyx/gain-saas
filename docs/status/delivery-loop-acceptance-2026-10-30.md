# 交付闭环消费侧验收报告（GainOS / gain-saas）

> 日期：2026-10-30（xin）
> 对象：GainOS（`/global/gain-saas`，vben SPA + NestJS，`127.0.0.1:4020`；tailnet `100.68.31.20:4020`）
> 引擎：global-backend 运行镜像 `a2c2c728`（build 于 2026-10-29T17:21Z）；模型网关 `http://127.0.0.1:3001/v1`，获客模型 `gemini-3.8-flash`，推理档（含 `outreach.first_contact_draft`）`gpt-6.1-terra`
> 演示工作空间：「宁波宏达机电有限公司」（`982c2a12-e166-430e-973c-01eea42ae9ed`），admin `owner@demo.cn`
> 结论：**消费侧主链已在 GainOS 跑通**（事件 ACK、线索档案包、周报 CSV、开发信草稿 Grant 签发与付费生成）。本次发现并修复 3 个 GainOS 侧缺陷；4 项引擎侧缺口交回 backend；草稿的付费生成已获产品负责人授权并实测通过（`gpt-6.1-terra`，8.0 秒）。

## 1. 验收结果

| # | 项目 | 命令 / 依据 | 结果 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | 登录与会话 | `POST /api/auth/login` → `GET /api/auth/session` | 200；工作空间与 admin 角色正确 | ✅ |
| 2 | 健康就绪 | `GET /health/ready` | 200；`db.ok`、`engine.ok`、`capabilities.event_consumer=true` | ✅ |
| 3 | 公司档案 | `GET /api/companies` | 200，返回已建档公司 | ✅ |
| 4 | 目标买家（ICP） | `GET /api/icps` | 200，多个 ACTIVE ICP | ✅ |
| 5 | 线索队列 | `GET /api/icps/:icpId/lead-queues` | 200：recommended 3、needs_review 127、rejected 80、sanctions_hold 5、scored=true | ✅ |
| 6 | 线索列表 | `GET /api/leads?limit=3` | 200，带游标分页 | ✅ |
| 7 | 线索档案包 | `GET /api/leads/6b5aef6d-…/package` | 200：公司事实、六维分、证据 URL、建议联系路径、制裁状态与有效期 | ✅ |
| 8 | 事件交付/ACK | 引擎 `outbox_delivery`：`saas|ACKED|309`；GainOS `event_inbox` 309 条且 `acked_at` 全非空（ClaimApproved 211、ICPActivated 33、DiscoveryRunCompleted 21、LeadQualified 16、SiteBuildCostSummaryUpdated 16、LeadsScored 12）；`qualified_lead` 16 条 | 无 PENDING/DEAD，16 条 LeadQualified 已派生成线索 | ✅ |
| 9 | 通知中心 | `GET /api/notifications` | 200，含 LeadQualified / DiscoveryRunPartial 通知与深链 | ✅ |
| 10 | 周报 CSV | `GET /api/reports/weekly?icpId=…&week=2026-W44`（admin） | 200，`text/csv; charset=utf-8`，3 行，`x-report-withheld-*` 三个响应头透传；首字节 `EF BB BF`（BOM，修复后） | ✅ |
| 11 | 周报「开发信草稿」列 | 引擎侧导出 ICP `47ddf7c0-…`、W44；GainOS 导出 ICP `e3b3b098-…`、W44 | 200；线索 `6b5aef6d-…` 行含 1,376 字符德语草稿；新生成的 `4bc9ac9c-…` 行含 769 字符草稿（v1，见 #19） | ✅ |
| 12 | 开发信草稿 Grant 报价 | `POST /execution-budget/workspace-technical-quote` `{operation:"POST /leads/:leadId/outreach-drafts", leadId}` | 200；purpose `outreach.draft`、subjectType `lead`、cap `400000` microusd、TTL 5 分钟 | ✅ |
| 13 | 开发信草稿 Grant 签发 | 用 GainOS 签发器按报价本地签发 | claims：`execution-budget-grant/v1`、`aud=global-backend:execution-budget`、`iss=https://127.0.0.1:18446/execution-budget`、purpose/subject/request_sha256/cap 与报价一致、TTL 240s | ✅ |
| 14 | Grant 端到端校验（零成本） | `POST /api/leads/85377b16-…/outreach-drafts`（**未被接受**的线索） | 引擎先验 Grant 再以 422 `OUTREACH_DRAFT_LEAD_NOT_ACCEPTED` 拒绝；**未调用模型** | ✅ |
| 15 | 草稿中文译文展示 | `apps/web/src/views/leads/index.vue` 的 `draftText` | 引擎合同字段为 `bodyZh`；修复前不显示中文译文，修复后显示 | ✅（已修） |
| 16 | 错误三层文案 | `packages/shared/src/errors.ts` | 修复前 `OUTREACH_DRAFT_LEAD_NOT_ACCEPTED` 落「未登记的错误」；修复后三层文案正确 | ✅（已修） |
| 17 | 草稿读取（旧草稿回看） | `GET /api/leads/:id/outreach-drafts` | 运行镜像 `a2c2c728` 无该 GET 路由（`404 Cannot GET`）；源码工作区已有、尚未提交/发版 | ⚠️ 引擎侧（G4） |
| 18 | 线索详情 | `GET /api/leads/:id` | 502，引擎 `SCOPE_REQUIRED`（该端点要求 `personal-data:read`，仅服务身份持有） | ⚠️ 引擎侧（G5） |
| 19 | 草稿生成（付费，已授权） | `POST /api/leads/4bc9ac9c-…/outreach-drafts`（admin） | 201，8.0 秒；v1、语言 `de`、模型 `gpt-6.1-terra`；subject 54 字符、body 538 字符、中文译文 `bodyZh` 148 字符、`usedFacts` 4 条；已落库并在周报第 11 项中出现 | ✅ |
| 20 | member 角色 | 演示库只有 admin 账号 | 无 member 账号，未验证 | ⏳（G9） |

## 2. 缺口清单

| # | 侧 | 缺口 | 影响 | 处置 |
| --- | --- | --- | --- | --- |
| G1 | GainOS | BFF 用 `res.text()` 读非 JSON 响应，按 fetch 规范吞掉 CSV 的 UTF-8 BOM | Excel 打开周报中文乱码 | **已修**（`engine-http.ts`，原始字节透传） |
| G2 | GainOS | 前端只读 `body_zh/translation/text`，不读引擎合同字段 `bodyZh` | 草稿中文译文不显示 | **已修**（`leads/index.vue`） |
| G3 | GainOS | `OUTREACH_DRAFT_LEAD_NOT_ACCEPTED` / `OUTREACH_DRAFT_UNGROUNDED` / `OUTREACH_DRAFT_VERSION_CONFLICT` 未登记文案 | 用户看到「未登记的错误」 | **已修**（`packages/shared/src/errors.ts`） |
| G4 | backend | `GET /leads/:leadId/outreach-drafts` 只存在于 backend 工作区、未提交/未发版；运行镜像无此路由 | 刷新/换设备后看不到已有草稿（GainOS 暂靠浏览器 localStorage） | 交回 backend（路由已在工作区） |
| G5 | backend | `GET /leads/:leadId` 要求 `personal-data:read`（服务身份专属）；`canonical-companies/:id`、`GET /suppressions` 同理 | 租户侧线索详情/公司详情/禁联名单不可用（GainOS 界面未依赖线索详情，档案包走 `/package` 不受影响） | 交回 backend：提供不含个人联系人的租户详情合同；产品决定禁联名单口径 |
| G6 | backend | 引擎先消费 Grant 再做业务前置校验：同一线索第一次 422 后再调直接 `409 EXECUTION_BUDGET_GRANT_REUSED` | 「生成草稿」失败后无法原线索重试 | 交回 backend（修复已写在 backend 工作区，见 status 下一步 6） |
| G7 | 产品 | ~~草稿生成的真实模型调用未执行~~ **已解决** | 2026-10-30 产品负责人授权后实测：201、8.0 秒、`gpt-6.1-terra`、德语 v1、中文译文 148 字符 | 已执行（见 #19） |
| G8 | 治理 | `/global/gain-saas` 不是 git 仓库，代码只在本机 | 无法回滚/交付/多人协作 | **已按产品负责人 2026-10-30 指示建仓并走 PR**（链接见文末） |
| G9 | 验收 | 演示库只有 admin 账号 | member 角色的 BFF 门与错误文案未验证 | 需要产品/运营创建一个 member 账号（或授权创建测试账号） |

## 3. 改动清单

| 文件 | 改动 | 验证 |
| --- | --- | --- |
| `apps/server/src/bff/engine-http.ts` | 非 JSON 响应改为 `Buffer.from(await res.arrayBuffer())` 原样透传，保留 BOM | 单测 2 项；4021 实例与 4020 实测 CSV 首字节 `EF BB BF` |
| `apps/server/src/bff/engine-http.test.ts`（新增） | CSV 字节/BOM 保留 + JSON 仍解析为对象 | `vitest run` 通过 |
| `apps/web/src/views/leads/index.vue` | 草稿文本读取引擎合同字段 `bodyZh`（保留旧键兼容） | `vite build` 通过；新 bundle 含 `bodyZh` |
| `packages/shared/src/errors.ts` | 新增 3 个开发信草稿错误码的三层文案 | 单测新增 1 项 |
| `packages/shared/src/errors.test.ts` | 上述文案的回归测试 | `vitest run` 通过 |

验证命令与结果：

```bash
cd /global/gain-saas
corepack pnpm --filter @gain-saas/shared test    # 4 passed
corepack pnpm --filter @gain-saas/server test    # 40 passed (9 files)
corepack pnpm --filter @gain-saas/shared build   # tsc 通过
corepack pnpm --filter @gain-saas/server build   # tsc 通过
corepack pnpm --filter @vben/web-antd build      # vite build 通过
```

生效：`gain-saas web` 已重启（2026-10-30 17:20 CST，`node dist/main.js`，监听 `0.0.0.0:4020` 与重启前一致）；worker 未重启、未改动。

## 4. 复现命令

```bash
# 登录（演示账号）
curl -sS -c /tmp/live.cookies -H 'content-type: application/json' \
  -d '{"email":"owner@demo.cn","password":"demo1234ab"}' \
  http://127.0.0.1:4020/api/auth/login

# 公司档案 / 目标买家 / 队列 / 线索
curl -sS -b /tmp/live.cookies http://127.0.0.1:4020/api/companies
curl -sS -b /tmp/live.cookies http://127.0.0.1:4020/api/icps
curl -sS -b /tmp/live.cookies http://127.0.0.1:4020/api/icps/<icpId>/lead-queues
curl -sS -b /tmp/live.cookies 'http://127.0.0.1:4020/api/leads?icpId=<icpId>&queue=recommended&limit=5'

# 线索档案包
curl -sS -b /tmp/live.cookies http://127.0.0.1:4020/api/leads/<leadId>/package

# 周报 CSV（校验 BOM 与 withheld 头）
curl -sS -D /tmp/weekly.hdr -b /tmp/live.cookies -o /tmp/weekly.csv \
  'http://127.0.0.1:4020/api/reports/weekly?icpId=<icpId>&week=2026-W44'
xxd /tmp/weekly.csv | head -1        # 期望 efbbbf 开头
grep -i 'x-report-withheld' /tmp/weekly.hdr

# 事件交付对账（引擎侧）
DOCKER_CONTEXT=default docker exec global-postgres psql -U global -d global_dev -Atc \
  "select sink,status,count(*) from outbox_delivery group by 1,2"   # saas|ACKED|309

# 事件入库对账（GainOS 侧）
URL=$(grep -m1 '^DATABASE_URL=' /global/gain-saas/.env | cut -d= -f2-)
psql "$URL" -Atc "select type,count(*),count(acked_at) from event_inbox group by 1"

# 开发信草稿生成（付费；2026-10-30 已授权并执行，见验收 #19）
curl -sS -b /tmp/live.cookies -X POST -H 'content-type: application/json' -d '{}' \
  http://127.0.0.1:4020/api/leads/<已接受 leadId>/outreach-drafts
```

Grant 报价/签发与「周报含草稿」的验证脚本保存在本会话 scratchpad（`/tmp/verify-grant.cjs`、`/tmp/verify-weekly.cjs`，仅本机本次会话有效）。

## 5. 交给 backend / 产品负责人

- **backend（G4/G5/G6）**：① 提交并发布 `GET /leads/:leadId/outreach-drafts`（工作区已有）；② 为租户提供不含个人联系人的线索/公司详情合同（`personal-data:read` 不再由租户端点要求），或产品决定维持现状；③ 草稿/ICP 的「先校验、已有草稿直接返回」修复发版，消除 `EXECUTION_BUDGET_GRANT_REUSED`。
- **产品负责人（G8/G9）**：① `/global/gain-saas` 已按 2026-10-30 指示建仓，本次改动走 [PR #1](https://github.com/mlhjyx/gain-saas/pull/1)；② 需要时创建一个 member 演示账号以验证成员角色。
- **治理**：`/global/gain-saas` 位于工作区顶层白名单之外（`gctl doctor` 已报警），建议随建仓一并纳入 `CLAUDE.md` 的目录契约与密钥清单核对。

---

仓库：<https://github.com/mlhjyx/gain-saas>（2026-10-30 建仓，私有）；本报告与修复随 [PR #1](https://github.com/mlhjyx/gain-saas/pull/1) 提交。

# 引擎侧对接前置(必须由引擎运维在部署窗口完成)

SaaS 侧代码不依赖本文件即可开发与测试;但以下 4 项不完成,**BFF 全部业务调用与事件消费都会被引擎 401/403 拒绝**(前端会看到三层文案提示"联系运营",这正是设计行为)。

> 2026-10-29 实测修正(旧版本有四处会导致静默失败):
> - `AUTH_WORKSPACE_CLAIM` 的代码默认值是 `workspace_id`,**不是** `workspace`;不显式设成 `workspace`,SaaS 的 token 全部 `TOKEN_INVALID`。
> - dev 下不能用 `http://172.18.0.1:4020` + `https://gain-saas.local`:准入要求 JWKS 与 issuer 同为 https(或同为 http+loopback);而**撤销信任复用 `AUTH_JWKS_URI` 并要求它是 https**,纯 http 会让 `/api/v1/platform-authority/fence-ack-jwks` 变 503(R4 静默退化)。
> - 因此本机走 **https 回环端点** `https://127.0.0.1:18446`(TLS 由 socat 终止,证书由引擎已信任的 `growthos-server-ca` 签发),不是 4020 裸 http。
> - `outbox_event` 对 `app_user` 启用 RLS,回填用 `OPS_APP_DATABASE_URL` 会静默读到 0 行,必须用 owner/BYPASSRLS 连接。

## 0. 一键执行(需要 root)

```bash
# 1) 演练:只打印将改的键,不写文件、不起服务
sudo python3 /global/gain-saas/deploy/engine-integration-apply.py

# 2) 真正执行:TLS 端点 → 归档 → 合并 env(AUTH + 预算 Grant 信任根)→ 重建 api/worker/platform-worker → readiness → R4 护栏
sudo python3 /global/gain-saas/deploy/engine-integration-apply.py --apply

# 3) 验证(以 xin 身份,非 root)
node /global/gain-saas/deploy/verify-engine-integration.mjs

# 收尾:env 已写入但容器重建失败(权限/网络)时,只重建容器,不重复归档
sudo python3 /global/gain-saas/deploy/engine-integration-apply.py --restart-only

# 回退:用最近一次「会改变配置」的归档还原 env 并重建容器
sudo python3 /global/gain-saas/deploy/engine-integration-apply.py --rollback
```

> 重启容器由 **root** 直接跑 `runtime.sh`。不要降权到 xin:compose 客户端要读 `backend/.secrets/*.env`(600 root),xin 读不到(2026-10-29 实测会报 `permission denied`)。脚本已用 `GIT_CONFIG_*` 放行 root 对 xin 仓库的 `safe.directory` 检查,并固定 `DOCKER_CONTEXT=default`。

**执行前必须确认一件事**:引擎只有一个 `AUTH_JWKS_URI`/issuer。改指向 gain-saas 后,**GrowthOS(18444)签发的用户 token 不再被引擎接受**。这是产品交接决定;回退用上一条命令。

前置(已就绪):gain-saas web 在 `127.0.0.1:4020` 运行;`gain-saas/.env` 的 `ENGINE_JWT_ISSUER=https://127.0.0.1:18446`;`r4-pki` 的 `growthos-server-ca` 私钥在 `/global/local-config/pki`(root 0700)。

## 1. JWKS 验签指向 gain-saas(https 回环端点)

引擎经 `AUTH_JWKS_URI / AUTH_ISSUER / AUTH_AUDIENCE` 验签(`global/backend/apps/api/src/auth/jwks-token-verifier.ts`),env 在 `/global/backend/.secrets/backend-runtime.env`(api/worker);`backend-platform-worker-runtime.env` 里有一份同名副本,两处必须同步——脚本会一起改。

```bash
# /global/backend/.secrets/backend-runtime.env(以及 backend-platform-worker-runtime.env)
AUTH_JWKS_URI=https://127.0.0.1:18446/.well-known/jwks.json
AUTH_ISSUER=https://127.0.0.1:18446
AUTH_AUDIENCE=global-backend
AUTH_WORKSPACE_CLAIM=workspace        # 必填:代码默认是 workspace_id
AUTH_ROLES_CLAIM=roles                # 默认即 roles,显式写出便于审计
# AUTH_CLOCK_SKEW_S 保持现值(60)
```

SaaS 侧 `.env` 的 `ENGINE_JWT_ISSUER` 必须与 `AUTH_ISSUER` **逐字符一致**(当前已是 `https://127.0.0.1:18446`)。

### 为什么是 https 回环端点,而不是 4020 裸 http

- api/worker 是 `network_mode: host`,容器直接看到宿主 `127.0.0.1`。
- `apps/api/src/runtime/runtime-admission.ts` 的 `inspectAuth`:non-test 模式要求 JWKS 与 issuer **同时为 https**;唯一豁免是 development 下两者都是 http 且 hostname 都是 loopback。
- `apps/api/src/platform-authority/platform-revocation-trust.runtime.ts` 把 `AUTH_JWKS_URI` 也算进撤销信任的 URI 集合,`httpsUri()` 对它强制 https;不满足时快照为 null,`fence-ack-jwks` 直接 503。**这条决定了不能用 http 捷径。**
- 代价是 fence-ack 每次 `open()` 都会抓这个 JWKS(2 秒超时),所以 gain-saas web + TLS 端点必须常驻;这和之前依赖 GrowthOS JWKS 是同一类本地依赖。
- 引擎的 `NODE_EXTRA_CA_CERTS` 是 `/run/secrets/machine/bootstrap-ca.pem`(= `growthos-server-ca`),所以 TLS 端点用该 CA 签一张专用叶子即可,不需要改信任束。

### TLS 端点(脚本自动完成)

| 件 | 位置 |
| --- | --- |
| 叶子证书/私钥 | `r4-pki` 新增 `gain-saas-jwks`(SAN `IP:127.0.0.1,DNS:localhost`,growthos-server-ca 签发),分发到 `deploy/tls/server.pem|server.key` |
| CA(公开) | `deploy/tls/ca.pem`(= growthos-server-ca,供 verify 脚本校验) |
| TLS 终止 | `deploy/systemd/gain-saas-jwks-tls.service`(socat `127.0.0.1:18446` → `127.0.0.1:4020`) |

手工步骤(等价于脚本所做,便于排障):

```bash
sudo /global/local-config/bin/r4-pki init      # 幂等;只新增缺失的 gain-saas-jwks 叶子
sudo /global/local-config/bin/r4-pki install   # 可选:按消费者分发(含 deploy/tls)
sudo cp /global/gain-saas/deploy/systemd/gain-saas-jwks-tls.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now gain-saas-jwks-tls
curl --cacert /global/gain-saas/deploy/tls/ca.pem https://127.0.0.1:18446/.well-known/jwks.json
```

证书 365 天。`r4-pki renew` 会重签它(私钥保留);续期后重跑 `r4-pki install` 并 `systemctl restart gain-saas-jwks-tls`。

**SaaS JWKS 私钥泄露已修 + 已轮换**:2026-10-29 之前 `/.well-known/jwks.json` 把 RSA 私钥参数(`d/p/q/dp/dq/qi`)一起公开;现在只输出 `kty/n/e/kid/alg/use`。旧私钥已在任何引擎开始信任它之前作废,新钥 `kid=dev-2026-10-29-b`(引擎首次信任的就是这一把)。引擎的 `loadExecutionBudgetJwks` 也会把带私钥字段的 JWKS 判为不可用,所以这个修复同时是撤销信任的前提。验证:

```bash
curl -s --cacert /global/gain-saas/deploy/tls/ca.pem https://127.0.0.1:18446/.well-known/jwks.json \
  | python3 -c 'import json,sys; print(sorted(json.load(sys.stdin)["keys"][0]))'
# 期望:['alg', 'e', 'kid', 'kty', 'n', 'use']
```

## 2. 角色 → scope 映射(引擎 AUTH_ROLE_SCOPE_MAP_JSON)

引擎按 token 的 `roles` claim 查此映射授 scope;**未登记的角色一票 deny**。在现有 JSON 上**合并**(保留 GrowthOS 的 `TENANT_OWNER/ADMIN/MEMBER`,不替换):

```json
{
  "saas-admin": [
    "acquisition:read", "acquisition:write", "acquisition:review", "acquisition:event:ack",
    "acquisition:label:write", "acquisition:identity:review", "acquisition:export", "compliance:manage"
  ],
  "saas-member": [
    "acquisition:read", "acquisition:write", "acquisition:review", "acquisition:label:write"
  ],
  "saas-event-consumer": [
    "acquisition:read", "personal-data:read", "acquisition:event:ack"
  ]
}
```

说明:
- `personal-data:read` 仅授予 `saas-event-consumer`(`GET /events` 的 AND 语义硬要求,SD5;该角色只存在于 worker 的机器 token,永不进用户 token)。
- `ops:read` 不授予任何 SaaS 角色(运营域走 PG 白名单,不用引擎业务 API)。
- **已知的 scope 缺口(按 PRD 设计保留,不是本次遗漏)**:BFF 的 `GET /leads/:leadId`、`GET /canonical-companies/:id` 需要 `personal-data:read`,`GET /data-providers` 需要 `ops:read`,成员可见的 `/suppressions` 系列需要 `compliance:manage`;这些路由在 M3 接入前要么调整 BFF 的 access,要么由产品重新决定 scope——**不要**为了跑通就把 `personal-data:read` 塞进用户角色。
- **联系人挖掘 M4(2026-11-01)**:引擎镜像 `d391a5f5` 已包含 `POST /canonical-companies/:id/discover-contacts`、`POST /canonical-companies/:id/guess-emails`、`POST /contact-points/:id/verify` 与 `GET /canonical-companies/:id`(2026-11-01 用 `/api/docs-json` 核实)。这四个端点在引擎侧还要求 `personal-data:read`;BFF 已把四条路由标为 `access: admin`(决策人卡片只对工作空间管理员渲染),但**该 scope 仍未授予任何 SaaS 角色**。要让 M4 在真实环境生效,需由产品/安全决定:引擎新增只覆盖联系人功能的窄 scope(推荐,避免顺带打开线索详情/禁联名单/建站档案),或只对 `saas-admin` 增补 `personal-data:read`(届时同步更新本文件的角色表与 `engine-integration-apply.py`)。在此之前,卡片会显示「获客能力尚未完成授权对接」并保持只读,不会误报成功。
- **联系人发现暂时无法铸造 Grant(引擎侧缺口)**:引擎的 `workspace-technical-quote` 对 `POST /canonical-companies/:id/discover-contacts` 明确 fail-closed(`EXECUTION_BUDGET_QUOTE_UNAVAILABLE`,见引擎 `workspace-technical-budget-envelope.ts`:Contact discovery is outside the company-level acquisition chain)。因此「发现联系人」动作在引擎补上联系人阶段预算账户/报价(设计稿 D7,scope=contact.discovery)前无法签发一次性 Grant;BFF 会把该错误码原样透出为「这项操作还没有可用的执行预算账户」,不会误报成功。`guess-emails`/`verify` 不受此限。
- 事件消费验证:`EVENT_CONSUMER_ENABLED=true` 后 `gain-saas-worker` 日志不再出现"引擎拒绝事件拉取",`outbox_delivery` 的 PENDING 开始转为 ACKED。

> 配置值已用引擎仓编译好的 `JwksTokenVerifier` + `createRolesToScopesPolicy` 对运行中的 SaaS 预演(2026-10-29):https token 验签通过、三角色 scope 与预期一致、不设 `AUTH_WORKSPACE_CLAIM` 时按预期 `TOKEN_INVALID`。

## 3. 存量回放(PRD G4)

已执行(2026-10-29):引擎侧实际是 **6 个工作空间 / 382 条事件**,`outbox_delivery` 279 条 PENDING(旧文档的"11 个工作空间"是历史数据,已过期)。SaaS 的 `workspace_registry` 已登记 6 个;缺失的 SaaS `workspace` 影子行由脚本补建(registry 有外键)。

重复执行时的正确命令(必须用 owner/BYPASSRLS 连接,`app_user` 会被 RLS 过滤成 0 行):

```bash
cd /global/gain-saas
ENGINE_DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' /global/backend/packages/db/.env)" pnpm bootstrap:backfill
```

脚本同时修了三个问题:导入路径(`./shared` → `../shared`)、根 `package.json` 缺 `bootstrap:backfill`、registry 外键缺影子 workspace。

## 4. 执行预算 Grant(2026-10-29 已决定迁到 gain-saas)

> 产品负责人 2026-10-29 决定:**Grant 签发从 GrowthOS 移到 gain-saas,gain-saas 不再依赖 GrowthOS**。SD3 的“SaaS 不签发 grant”就此被取代;本文件记录新的运行合同。

鉴权接通后,以下写接口还需要 **`X-Execution-Budget-Grant`**:

`POST /companies`、`POST /companies/:companyId/icps`、`POST /icps/:icpId/query-plans`、`POST /query-plans/:planId/execute`、`POST /leads/:leadId/outreach-drafts`(以及未进 BFF 的 contacts/email/site-builder 写路径)。

引擎合同(实测):
- Grant 是一次性、请求绑定、≤5 分钟的 JWT(`execution-budget-grant+jwt`);引擎只验签/消费/结算,不签发。
- `POST /api/v1/execution-budget/workspace-technical-quote` 返回签发所需的全部字段:`requestSha256`、`purpose`、`subjectId`、`requiredCapMicrousd`、`policyRevision`、`expiresAt`。`POST /companies`(hongdamuju.com)实测报价 **5,870,000 microusd**。
- `cap_microusd` 必须与 quote 的 `requiredCapMicrousd` 一致;`subject_id` 在 `POST /companies` 上是 `request:<requestSha256>`;Grant 的 `iss` 必须等于引擎 `EXECUTION_BUDGET_GRANT_ISSUER`。

### gain-saas 的实现

| 件 | 位置 |
| --- | --- |
| 独立预算签名钥 | `.env` 的 `ENGINE_BUDGET_GRANT_PRIVATE_KEY` / `_KEY_ID`(与身份钥分离,600) |
| Grant issuer | `ENGINE_BUDGET_GRANT_ISSUER=https://127.0.0.1:18446/execution-budget` |
| 预算 JWKS | `https://127.0.0.1:18446/.well-known/execution-budget-jwks.json`(只含公钥) |
| BFF 流程 | 5 条写路由先调 quote → 用 quote 签 Grant → 带 `X-Execution-Budget-Grant` 调业务接口(`apps/server/src/bff/engine-budget-grant.service.ts`) |

引擎侧(只改 `backend-runtime.env`,api/worker):

```bash
EXECUTION_BUDGET_GRANT_JWKS_URI=https://127.0.0.1:18446/.well-known/execution-budget-jwks.json
EXECUTION_BUDGET_GRANT_ISSUER=https://127.0.0.1:18446/execution-budget
EXECUTION_BUDGET_GRANT_AUDIENCE=global-backend:execution-budget
EXECUTION_BUDGET_GRANT_ALGORITHMS=RS256
```

`backend-platform-worker-runtime.env` 的 `EXECUTION_BUDGET_GRANT_*` **保持 GrowthOS**:平台 Grant/撤销仍走 R4 信任根(平台 schedule 仍 paused)。gain-saas 的用户写路径不再经过 GrowthOS。

**R4 取舍**:api 的 `PlatformRevocationTrustRuntime` 复用 `EXECUTION_BUDGET_GRANT_*`,改指 gain-saas 后 GrowthOS 的撤销回执不再被 api 验证;fence-ack 端点仍应 200(它会抓 gain-saas 的预算 JWKS)。apply 脚本在重建后跑 `check_r4_fence_ack()` 兜底。

**预演结果(2026-10-29)**:用引擎仓编译好的 `ExecutionBudgetGrantVerifier` 对 gain-saas 签出的 Grant 做同代码路径验证,已通过(issuer `…/execution-budget`、kid `budget-2026-10-29`、cap `5870000`、purpose/workspace/request_sha256 全部匹配)。

apply 前必须让 gain-saas web 加载新代码和预算钥:

```bash
cd /global/gain-saas && pnpm --filter @gain-saas/shared build && pnpm --filter @gain-saas/server build
# 重启 4020(开发期 nohup)
curl -s http://127.0.0.1:4020/.well-known/execution-budget-jwks.json   # 应 200 且 kid=budget-2026-10-29
sudo python3 /global/gain-saas/deploy/engine-integration-apply.py --apply
```

apply 后 `POST /api/companies` 应返回 **202**(不再 402);`verify-engine-integration.mjs` 增加预算 JWKS 与引擎 readiness 检查。

## 5. 开启事件消费并验证


引擎侧配置生效后:

```bash
# 1) 打开开关
sed -i 's/^EVENT_CONSUMER_ENABLED=false/EVENT_CONSUMER_ENABLED=true/' /global/gain-saas/.env
# 2) 启动 worker(systemd 单元装好之前用 nohup)
cd /global/gain-saas/apps/server && setsid nohup node dist/worker.js >> /tmp/gain-saas-worker.log 2>&1 < /dev/null &
# 3) 预期:按 registry 逐 workspace 拉取(每 workspace 每轮一页,默认 100 条,游标推进),
#    event_inbox 入库,outbox_delivery 转 ACKED;344 条的主 workspace 需要约 4 轮(默认 2 分钟/轮)
tail -f /tmp/gain-saas-worker.log
psql "postgresql://global:global@127.0.0.1:5432/global_dev" -c "select status,count(*) from outbox_delivery group by 1"
```

### 验证顺序

1. `node /global/gain-saas/deploy/verify-engine-integration.mjs` → JWKS 无私钥、三种角色调用 200、`saas-member` 拉事件 403、**R4 fence-ack 仍 200**(https `AUTH_JWKS_URI` 没有破坏撤销信任)。
2. `curl http://127.0.0.1:4020/health/ready` → `engine.ok=true`;浏览器注册一个工作空间,携带 cookie 调 `GET /api/leads`(经 BFF)→ 不再是 401/403 的"授权无效"文案。
3. 引擎侧制造一条事件(如 `POST /api/v1/companies`)→ worker 轮询后 SaaS `notification`/`event_inbox` 出现该事件 → `outbox_delivery.acked_at` 非空。

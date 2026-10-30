# R4 平台权威迁移：让 gain-saas 接管、GrowthOS 退役

> 文档 ID：`DOC-SAAS-TECH-R4-001`
> 生命周期：`DRAFT`（待产品负责人评审；批准后改 `APPROVED` 再施工）
> 制定日期：2026-10-30
> 依据：用户 2026-10-30 指示「GrowthOS 要退役，需要实现什么功能进去，分析和计划清楚」
> 编写时核验：2026-10-30，xin 运行态（`global-api` env、`capability-probe` 探针、RUNBOOK §1）

## 1. 现状：身份已经分家，权威还没

| 职责 | 现在由谁承担 | 证据 |
| --- | --- | --- |
| 用户登录 / 产品身份 | **gain-saas**（已完成） | 后端 `AUTH_ISSUER` / `AUTH_JWKS_URI` = `https://127.0.0.1:18446` |
| 机器 token、capability、Temporal 运行时信任 | **GrowthOS** | 后端 `CAPABILITY_MACHINE_JWKS_URI`、`PLATFORM_CAPABILITY_JWKS_URI`、`TEMPORAL_MACHINE_JWKS_URI`、`PLATFORM_TECHNICAL_QUOTE_AUTH_ISSUER` 全指向 `https://127.0.0.1:18444`；`PLATFORM_CAPABILITY_GROWTHOS_SHA=6bbfa1cc…` |

所以「退役 GrowthOS」准确地说是：**把 R4 平台权威从 GrowthOS 迁到 gain-saas**，用户身份那半边已经完成。

## 2. GrowthOS 为 R4 承担的全部职责（迁移清单）

| # | 职责 | 形状 | 谁在消费 |
| --- | --- | --- | --- |
| 1 | **机器 token 签发** | `POST /api/internal/v1/platform-machine-tokens`，mTLS 入口（内部 TLS 18443） | 后端 `MachineTokenClient` |
| 2 | **Capability 签发** | `POST /api/internal/v1/platform-automation/capabilities`，返回签名 JOSE，内含 4 个 schedule 的 `temporal_proof` | 后端 `CapabilityRuntime` |
| 3 | **JWKS 公钥族** | `/.well-known/jwks.json`（机器）、`/.well-known/platform-capability-jwks.json`、`/.well-known/temporal-runtime-jwks.json` 等（后端 0112 放行的是它要验的全部 5 份） | 后端验签 |
| 4 | **部署绑定消费** | `deployment-binding.json`：`backendSha` / `observedAt` / `validUntil`（7 天） | GrowthOS capability producer 用它把能力绑定到具体后端制品 |
| 5 | **镜像准入回执 / 密钥保留策略** | `platform-consumer-image-receipt.json`、`platform-recovery-key-retention.json` | 同上 |
| 6 | **撤销生产与投递** | 签发 HMAC → 调后端 `POST /api/v1/platform-authority/revocations` | 后端接收端（**链路当前未打通**） |
| 7 | **恢复通道客户端** | 经 `backend-recovery-tls`（3443）与 loopback relay 调后端 `fence-ack-jwks` / `revocations` / `target-lookup` / `technical-quote` | GrowthOS |
| 8 | **Consumer lease** | GrowthOS 库中 4 条 `ACTIVE` 租约，绑定消费者与镜像回执 | 运维验收 |
| 9 | **平台事实采集** | Temporal schedule 状态、egress 策略事实、deployment binding —— capability 的 `temporal_proof` 由这些组成 | capability 签发 |

## 3. gain-saas 必须实现的功能（逐项）

### F1 密钥体系与 JWKS 端点
- 生成并托管三类密钥：机器 token 签名键、capability 签名键、Temporal 运行时验证键。
- 暴露 5 个 JWKS 端点（机器 / capability / temporal-runtime 及后端要求的其余两份），**只出公钥**。
- 支持轮换与双钥并存期（旧键在过期窗口内仍可验）。

验收：后端把 `CAPABILITY_MACHINE_JWKS_URI` 等指到 gain-saas 后，验签通过；轮换时不断流。

### F2 机器 token 签发
- mTLS 入口，校验客户端证书；签发带 `sub` / `aud` / `scope` 的短时 token。
- 必须与后端 `machine-token-verifier` 的声明集合逐字匹配（后端有契约测试）。

验收：`capability-probe` 的 `step machine token: ok`。

### F3 Capability 签发
- 采集事实：4 个 platform schedule 的 Temporal 状态、egress 策略、deployment binding。
- 为每个 schedule 生成 `temporal_proof`，用 capability 键签成 JOSE。
- 绑定后端制品：`backendSha` / `image digest` / `artifact digest` 必须与 deployment binding 一致，否则拒绝签发。

验收：`capability-probe` 的 4 个 `temporal_proof=ok`。

### F4 部署绑定、回执与密钥保留的消费
- 读取 `/run/secrets/...` 下的三份产物，校验 `validUntil`（7 天）与摘要。
- 过期即拒绝签发（fail closed），不做静默降级。

验收：续期前后各跑一次；把 `validUntil` 人为改过期，确认拒绝。

### F5 撤销生产与投递（**顺带补齐当前断链**）
- 按后端 `platform-authority-issue-request` 契约构造撤销请求，用 HMAC keyring 签名。
- 投递到后端 `POST /api/v1/platform-authority/revocations`，处理 ACK 重放与幂等。
- 失败重试与死信可见（运维台可查）。

说明：这条链现在就没打通（后端缺调用 GrowthOS HMAC 签发端点的客户端，策略标 `BLOCKED_PENDING_BACKEND_4A4`）。迁移是补齐它的唯一自然窗口——否则迁完仍是断的。

### F6 恢复通道客户端
- 用专用 CA 建 HTTPS 客户端，调后端 `fence-ack-jwks` / `revocations` / `target-lookup` / `technical-quote`。
- 生产环境必须是真 TLS **服务端证书**，不得沿用开发期的 socat sidecar。

### F7 Consumer lease 与镜像回执
- 记录消费者与其镜像回执的绑定，定期续期；租约失效要能让 readiness 反映。

### F8 切换面：后端 env
- 需改的键（当前指向 18444）：`CAPABILITY_MACHINE_JWKS_URI`、`PLATFORM_CAPABILITY_JWKS_URI`、`PLATFORM_CAPABILITY_ORIGIN`、`PLATFORM_CAPABILITY_ISSUER`、`TEMPORAL_MACHINE_JWKS_URI`、`PLATFORM_TECHNICAL_QUOTE_AUTH_ISSUER`、`PLATFORM_CAPABILITY_GROWTHOS_SHA`。
- 切换走与 `gctl switch-backend` 等价的窗口：归档 → 改 env → 重建 api/worker/platform-worker → 探针验收 → 回退脚本。

## 4. 分阶段计划

| 阶段 | 范围 | 验收 | 回退 |
| --- | --- | --- | --- |
| P0 | 契约冻结：把后端 5 份 JWKS、2 个内部端点、4 个后端接收端点的 schema 抄成 gain-saas 的测试夹具 | 契约测试可跑，无实现 | — |
| P1 | F1 密钥 + JWKS | 后端指向后验签通过，轮换测试通过 | env 指回 18444 |
| P2 | F2 机器 token | probe `machine token: ok` | 同上 |
| P3 | F3+F4 capability 与绑定消费 | probe 4×`temporal_proof=ok` | 同上 |
| P4 | F5 撤销链（补齐断链） | 端到端：签发 → 投递 → 后端 ACK → 重放幂等 | 关闭投递开关 |
| P5 | F6 恢复通道（真 TLS） | 4 个后端接收端点全通 | 切回 sidecar |
| P6 | F7 租约与回执 | readiness 与租约一致 | — |
| P7 | 切换窗口：改 env、重建、验收、续 R4 7 天 | 全绿 | 归档回退 |
| P8 | 退役：停 GrowthOS 容器、归档 `growthos-source`/`growthos-work` | 观察 7 天无异常 | 按归档 README 恢复 |

## 5. 前置与依赖

1. **PRD4-D2「冻结 R4」需要重开**：退役 GrowthOS 属于 R4 投入，须产品负责人明确改决定（本文件即提请）。
2. **Temporal admin 凭据自动化**：`r4-pki token admin` 只有 20 分钟有效，P3 的验收需要可重复的签发路径。
3. **egress 策略**：目前由 GrowthOS 安装（generation 0→1）。迁移后需由 gain-saas 或后端生成，需定归属。
4. **部署绑定生成器**：仍是本机 `local-config/bin/r4-recovery`；迁移后保留在运维侧，gain-saas 只消费。
5. **L4-G23 写入者授权**：platform schedule 恢复仍需它；退役不改变 schedule 保持 paused。

## 6. 不在范围

- 用户登录/身份：已由 gain-saas 承担，不再改。
- platform schedule 的恢复运行：仍是产品负责人的单独决定（见 RUNBOOK §1）。
- GrowthOS 的历史数据迁移：MySQL 里的演示数据不迁，退役即归档。

## 7. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 撤销链在迁移前就是断的 | 迁移后若只搬不补，等于把已知缺陷搬过去 | P4 单列为验收门，端到端通过才算完成 |
| 7 天绑定过期导致静默失效 | capability 与恢复通道同时失效 | P7 后续期自动化，doctor 提前 48h 告警 |
| 密钥轮换期验签失败 | 平台自动化停摆 | 双钥并存 + 提前一轮预演 |
| 生产仍用 socat 终止 TLS | 安全边界不达标 | P5 明确要求真证书，socat 仅限本机开发 |

## 8. 估时（粗）

P0–P2 约 2–3 天；P3–P4 约 3–5 天（含契约联调）；P5–P6 约 2 天；P7 一个发布窗口；P8 观察期 7 天。
总计约 **2 周**，不含排期等待。

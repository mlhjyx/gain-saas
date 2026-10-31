# 平台撤销的自动触发（P9）

> 文档 ID：`DOC-SAAS-TECH-R4-REVOCATION-001`
> 生命周期：`CURRENT`
> 状态：已实现（默认关闭），待开启与实测
> 最后更新：2026-11-01
> 设计依据：global-backend `docs/superpowers/plans/2026-11-01-platform-revocation-autotrigger.md`（D1–D8 已由产品负责人 2026-11-01 按建议批准）

本文说明 gain-saas 侧「政策停用 / 部署绑定撤销 / 安全响应 → 平台撤销」的实现、配置与运行方法。wire 契约（撤销命令、ACK、后端 fence）一字未改；受审计的围栏重开路径在后端另立任务，本模块不重开围栏。

## 1. 它解决什么

撤销链（签发 → 投递 → fence → ACK）在 2026-11-01 已用真实 Grant 实测通过，但 `RevocationIssuer` 没有生产调用方。本模块补齐**发起方**：

| 事件 | 来源 | 是否自动 | reason_code |
| --- | --- | --- | --- |
| 政策停用（受评审的部署期状态变更） | `R4_PLATFORM_POLICY_MODES` 镜像 → `r4_platform_policy_state` | 是（产生请求） | `POLICY_DISABLED` |
| 部署绑定显式撤销 | 绑定文件新增 `revokedAt` 等字段 | 是（轮询发现） | 文件携带 |
| 安全响应 / 运维停机 | 运营台「平台撤销」页 | 手动发起、立即投递 | `SECURITY_RESPONSE` / `OPERATOR_HOLD` |
| 部署绑定自然过期 | `validUntil` | **否**，只告警并停发新 Grant | — |

## 2. 数据模型

- `r4_revocation_request`：逻辑撤销请求。`fence_sequence` 在创建时由 `r4_revocation_sequence` 一次分配；同一 schedule 同时只允许一个未结请求（部分唯一索引）。
- `r4_revocation_attempt`：追加式投递尝试。保存完整 `command_jws` 用于**原字节重放**；每条尝试的 target/sequence/结果独立留痕。
- `r4_platform_policy_state`：策略状态镜像（首次见到只建基线，ENABLED→DISABLED 才产生请求）。
- 旧 `r4_revocation_outbox`（P6 遗留、从未有写入方）保持不动。

请求状态：

```text
PENDING_CONFIRMATION ──确认──▶ PENDING ──ACK 验签──▶ ACKED
        │                        │
        │                        ├──无 live Grant──▶ NO_LIVE_TARGET
        │                        ├──配置/密钥/复用──▶ BLOCKED
        │                        └──序列冲突──────▶ STORED_STATE_CONFLICT
        └──取消（从未投递）──────────────────────▶ CANCELLED
```

`delivery_unknown=true` 表示至少一次投递结果未知（网络/超时/503/ACK 验签失败）：请求保持 PENDING，同一字节继续重试；**绝不当作未提交**。

## 3. 关键语义

- **target 选择**：从 `r4_platform_grant` 取该 schedule `expires_at > now` 的 Grant 当 locator（平台 egress 授权有效期就是 Grant 的 `expires_at`，≤300 秒）。候选优先未尝试过的；`403 SCOPE_MISMATCH` 表示该 Grant 尚未 admitted，15 秒后重试或换下一条。没有 live Grant → 没有可出网的 authority，记 `NO_LIVE_TARGET` 终态。
- **失败分类**：
  - 403 SCOPE_MISMATCH → 确定性未命中，换/重试候选；
  - 409 EXPIRED → 该字节从未提交（已提交的同字节会返回原 ACK），允许 successor；
  - 409 SEQUENCE_CONFLICT → 停 `STORED_STATE_CONFLICT`，**不自动 +1**（沿用 2026-09-13 已批准规格）；
  - 400/401/415 → `BLOCKED`；
  - 429/503/网络/泛 409/ACK 验签失败 → 保持 PENDING，指数退避（5 秒→60 秒）。
- **积压即 fail closed**：`R4LeaseService` 的 `undeliveredCount` 改读逻辑请求（PENDING / BLOCKED / STORED_STATE_CONFLICT）；最老一条 >30 秒即拒绝签发 capability。`PENDING_CONFIRMATION`（人工门）与 `NO_LIVE_TARGET`（已解决）不计入。
- **Grant 签发门**：策略 DISABLED 或有未结撤销请求时，`PlatformGrantIssuer` 拒绝签发（`PLATFORM_GRANT_POLICY_DISABLED` / `PLATFORM_GRANT_REVOCATION_PENDING`）。

## 4. 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `R4_REVOCATION_TRIGGER_ENABLED` | `false` | 总开关：策略同步、绑定监视、投递循环、运营接口 |
| `R4_REVOCATION_AUTO_CONFIRM` | `false` | 自动来源是否免人工确认直接投递；受审计重开路径就绪前保持 false |
| `R4_PLATFORM_POLICY_MODES` | 三个 schedule 全 `ENABLED` | 必须与后端 policy asset 的 `desired_mode` 同窗口一致 |
| `R4_REVOCATION_MAX_TARGET_CANDIDATES` | `8` | 每次选 target 时扫描的 live Grant 上限 |

投递循环只在 web 进程运行（`worker.ts` 注入 `PROCESS_ROLE=worker`），避免双进程重复推进。

## 5. 运营台

`/ops` → 「平台撤销」：

- 查看三个有 egress 的 schedule 的策略状态与撤销请求；
- 发起撤销（二次确认，说明 schedule 级、不可重开、记入审计）；
- 确认自动来源的待确认请求；
- 取消只允许从未投递（`PENDING_CONFIRMATION`）或已确定未提交（`BLOCKED` / `STORED_STATE_CONFLICT`）的请求；`PENDING` 可能已提交，取消会被拒绝。

接口：`GET/POST /api/ops/r4/revocations`、`POST /api/ops/r4/revocations/:id/confirm|cancel`、`GET /api/ops/r4/policy-state`。

## 6. 部署绑定撤销格式

绑定文件（`R4_DEPLOYMENT_BINDING_FILE`）增加可选字段，写入后无需重启、下一轮轮询（≤15 秒）生效：

```json
{
  "validUntil": "...",
  "scheduleActions": [ ... ],
  "revokedAt": "2026-11-01T12:00:00Z",
  "revokeReasonCode": "SECURITY_RESPONSE",
  "revokedBy": "ops@example.com",
  "revokeNote": "部署凭据疑似泄露"
}
```

`revokedAt` 存在即为显式撤销；文件不可读 / JSON 损坏 / `validUntil` 过期都**不是**撤销（只告警并停发新 Grant）。

撤销字段是**终态**：`gctl switch-backend` 续绑定只改 `backendSha / observedAt / validUntil`，会保留 `revokedAt`。重新受信必须先人工调查、再显式删除这四个字段——续期不自动解除撤销（fail closed）。

## 7. 开启顺序（运维）

1. 确认后端 policy asset 与 `R4_PLATFORM_POLICY_MODES` 一致；
2. 在 gain-saas `.env` 设 `R4_REVOCATION_TRIGGER_ENABLED=true`（受审计重开路径就绪前保持 `R4_REVOCATION_AUTO_CONFIRM=false`）；
3. 应用迁移 `20261101090000_r4_revocation_autotrigger`，`pnpm build` 后重启 `gain-saas-web`；
4. 运营台「平台撤销」页确认基线已建立、无意外请求；
5. 首次真实撤销前确认 `PLATFORM_REVOCATION_RATE_LIMIT` / `_WINDOW_MS` 已配置（未配置时后端 503）。

回退：把总开关设回 `false` 并重启即可停止新动作；已提交的 fence 不回滚（撤销历史不可变）。

## 8. 边界

- 不 unpause 任何 schedule；撤销只围栏出网，不暂停 Temporal schedule。
- 不实现受审计重开；重开由后端的独立任务负责，本模块只提供它需要的 receipt 事实。
- 不改撤销/ACK/fence 的 wire 契约；`target-lookup` 通道仍未恢复。

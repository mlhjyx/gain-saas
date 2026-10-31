# P7：R4 切换清单（把平台权威从 GrowthOS 切到 gain-saas）

> 文档 ID：`DOC-SAAS-TECH-R4-003`
> 生命周期：`APPROVED`（产品负责人 2026-10-31 授权执行）
> 制定日期：2026-10-31
> 前提：P0–P6、P3d、P5b 已合并（gain-saas main），三个阶段决定已入档
>
> **执行状态（2026-10-31 18:15 UTC+8）**：第 1–4 步已完成并验收——
> 平台 `TEMPORAL_PLATFORM_JWKS_URI` 已指向 gain-saas（密钥延续，零停机），引擎三份
> env 的 5 个键已切换并重建三容器；readiness `ready`、`capability-probe`
> 4×`temporal_proof=ok`、platform worker 以 gain-saas 签发的 token 正常轮询。
> 第 5–8 步（撤销投递 + ACK 实测、绑定续期、30 分钟观察）待做。切换经过与回退见
> `/global/_archive/p7-platform-authority-cut-xin-20261031/`。

## 0. 这次切换改变什么

后端容器里 7 个 env 从 GrowthOS(18444/18081) 指向 gain-saas；切换后 GrowthOS 不再参与平台自动化，但**容器不删**（P8 才停）。

## 1. 前置检查

| 项 | 命令/位置 | 期望 |
| --- | --- | --- |
| 线上 readiness | `curl 127.0.0.1:3000/api/v1/health/ready` | ready |
| R4 绑定未过期 | `r4-recovery check` | 剩余 > 48 小时 |
| growthos 三容器健康 | `docker ps` | Up/healthy |
| gain-saas 可启动 | `pnpm --filter @gain-saas/server build` | 通过 |

## 2. 密钥与证书（root）

1. 生成 gain-saas 的 R4 密钥对（RSA 2048，PKCS#8），存 `0600`：
   `R4_MACHINE_PRIVATE_KEY` / `R4_CAPABILITY_PRIVATE_KEY` / `R4_TEMPORAL_RUNTIME_PRIVATE_KEY` / `R4_SITE_BUILD_BUDGET_PRIVATE_KEY`
   各自独立 kid（如 `gainsaas-machine-2026`）。
2. `r4-pki` 增加 gain-saas 消费者（新 subject `gain-saas-platform-authority`），签发叶子证书并 install；
   证书/私钥/CA 路径进入 `R4_TLS_*`。

## 3. 数据库

```bash
cd /global/gain-saas/apps/server
pnpm prisma migrate deploy   # 应用 20261030200000_r4_consumer_lease 与 20261030210000_r4_egress_install_audit
```

两条迁移只新增表，不动既有表；回滚方式是保留表不删（无破坏性）。

## 4. gain-saas 环境变量（新增，全部可选，缺失即 503）

| 变量 | 值 |
| --- | --- |
| `R4_MACHINE_TOKEN_ISSUER` | `https://<gain-saas>/temporal-runtime` |
| `R4_MACHINE_TOKEN_TEMPORAL_AUDIENCE` | 与引擎 `TEMPORAL_MACHINE_AUDIENCE` 一致 |
| `R4_MACHINE_SUBJECT` / `R4_MACHINE_CONFIGURATION_REVISION` | 由部署给出（后者 64 hex） |
| `R4_CAPABILITY_ISSUER` / `R4_CAPABILITY_AUDIENCE` / `R4_CAPABILITY_NAMESPACE` | 与引擎 `PLATFORM_CAPABILITY_*` 一致 |
| `R4_DEPLOYMENT_BINDING_FILE` | 指向部署绑定 JSON |
| `R4_EGRESS_EXPECTED_FILE` | 引擎容器内推导出的 JSONL |
| `R4_BACKEND_BASE_URL` / `R4_FENCE_ACK_ISSUER` | 引擎基址与 fence-ack issuer |
| `R4_TLS_PORT` / `R4_TLS_CERT_FILE` / `R4_TLS_KEY_FILE` / `R4_TLS_CA_FILE` | 第 2 步的产物 |

## 5. 切换顺序（不可跳步）

1. 起 gain-saas 的 mTLS 监听，自检三个 JWKS 端点可达（`curl --cert`）
2. 先切**只读**面：`CAPABILITY_MACHINE_JWKS_URI`、`PLATFORM_CAPABILITY_JWKS_URI`、`TEMPORAL_MACHINE_JWKS_URI`、`PLATFORM_TECHNICAL_QUOTE_AUTH_ISSUER` 指向 gain-saas
3. 重建 `api worker platform-worker`，等 `/health/build` attested
4. 验：`capability-probe` 4 个 `temporal_proof=ok`
5. 再切**写入**面：把平台端点（capabilities、machine tokens、revocations）指向 gain-saas
6. 发一条测试撤销，确认 `revocation_jti` 与 `command_sha256` 对得上、ACK 验签通过
7. `r4-recovery check` → `renew`，部署绑定续期
8. 观察 30 分钟：readiness、客户写入、GrowthOS 侧 ERROR 数为 0

## 6. 回退

- **第 2–4 步失败**：把 4 个 env 指回 18444，重建三容器，30 秒内恢复。
- **第 5–6 步失败**：把平台端点指回 GrowthOS，重建；gain-saas 侧停止投递（不产生副作用）。
- **数据库迁移**：不回滚（只新增表），可长期保留。
- GrowthOS 全程不被删除，回退不需要重建它（除三容器按 RUNBOOK §5 重建）。

## 7. 切换后才做的事（P8）

停 `growthos-local` 九容器、归档 `growthos-source` / `growthos-work`、删除 `switch-backend` 里「续 R4 + 重建 GrowthOS」的链条。
在此之前，**每次换镜像仍按现流程续 R4 并重建 GrowthOS 三容器**。

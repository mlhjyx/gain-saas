# M2 步 11-3/11-4 端到端演示（TEST-ONLY，本机 sink）

日期：2026-11-08
范围：批次创建 → 草稿生成 → 人工审批 → 逐封 L2 门 → SMTP 投递到本地 Mailpit（DKIM 签名有效）
→ 退订链接/token 生效 → 回复分类回写 → 退订/回复即停 → DNC 命中跳过 → 审计包结构。
**未发任何真实邮件**：出口白名单只允许 `127.0.0.1`，发送总开关仅在演示进程内显式打开。

## 环境

- 隔离演示库：`gain_saas_11_4_demo`（本机 PostgreSQL 5433），从零 `prisma migrate deploy`
- Mailpit `axllent/mailpit:v1.27.4`：`127.0.0.1:11025`（SMTP）/ `127.0.0.1:18025`（HTTP API）
- 测试域：`mail.gainos.test`（RFC 预留 `.test`）；DKIM `selector=test20261108`，RSA 2048
- DKIM 私钥只在 `/tmp`，未入库；公钥见 `dkim-public.b64`
- 独立验证器：dkimpy 1.1.8（注入公钥，避免真实 DNS 查询）

## 复现

```bash
docker run --rm -d --name gainos-mailpit-test \
  -p 127.0.0.1:11025:1025 -p 127.0.0.1:18025:8025 axllent/mailpit:v1.27.4

createdb -h 127.0.0.1 -p 5433 -U gain_saas gain_saas_11_4_demo
DATABASE_URL=postgresql://gain_saas:dev@127.0.0.1:5433/gain_saas_11_4_demo \
  pnpm --filter @gain-saas/server exec prisma migrate deploy

DEMO_DATABASE_URL=postgresql://gain_saas:dev@127.0.0.1:5433/gain_saas_11_4_demo \
OUTREACH_DKIM_PRIVATE_KEY_PATH=/tmp/outreach-11-3-evidence/dkim-test20261108.key \
  pnpm --filter @gain-saas/server exec tsx scripts/outreach-11-4-e2e-demo.ts

/tmp/dkim-verify-venv/bin/python verify-dkim.py mailpit-raw.eml dkim-public.b64
```

## 演示结果（`demo-result.json`，16 项全部 PASS；下表按主题归并）

| 步骤 | 结果 |
| --- | --- |
| 负向：未批准直发 | `OUTREACH_DRAFT_NOT_APPROVED`，一封未发 |
| 批次 A 发送 | `SENT 2`，Mailpit 收到 2 封 |
| DKIM 签名 | 存在 `DKIM-Signature v=1`；dkimpy `PASS` |
| List-Unsubscribe | 头存在，退订 token 在邮件里 |
| 退订消费 | `unsubscribed: true`，写 OPT_OUT，调用平台抑制同步 |
| 退订后发送 | `COMPLETED skipped 1`，Mailpit 无新增 |
| 回复分类回写 | `NEGATIVE` 1 条，写 OPT_OUT |
| 回复后发送 | `COMPLETED skipped 1`，无新增 |
| DNC 命中 | `SKIPPED`，原因 `OUTREACH_DNC_BLOCKED: global:unsubscribe` |
| DNC 查询失败 | `OUTREACH_DNC_UNAVAILABLE`，无新增（fail closed） |
| 重放已发送批次 | `OUTREACH_BATCH_ALREADY_SENT` |
| 审计包 | `outreach-audit-package/v1`，含批准人/时间、草稿正文、事件、`packageHash` |

DKIM 验证输出：

```
dkim_verify: PASS
dns_queries: ['test20261108._domainkey.mail.gainos.test.']
```

## 路由冒烟（真实 Nest 进程）

以隔离演示库启动真实服务（`PORT=14020`，发送开关关闭）后探测：

- `POST /api/public/outreach/unsubscribe` → `404 OUTREACH_UNSUBSCRIBE_TOKEN_INVALID`（到达 Nest 控制器，未被 BFF 中间件拦截）
- `GET /api/outreach/batches` → `401 AUTH_REQUIRED`（到达 TenantGuard）

这验证了 11-4 附带的 BFF 前缀放行修复；修复前两个路径都会被 BFF 兜底路由拦截。

## 能证明什么

- 从批次创建/审批到 SMTP 投递的完整服务链路可按门序执行；未批准直发在连接前被拒。
- 每封邮件带一次性退订链接与 `List-Unsubscribe`；token 消费后租户内 OPT_OUT 立即生效，后续同联系人批次跳过。
- 回复/退信/退订回写会写 OPT_OUT，后续批次自动跳过（不依赖人工取消）。
- DNC 命中与 DNC 查询失败两条路径均为 fail closed，跳过原因进入 append-only 台账与审计包。
- DKIM relaxed/rsa-sha256 签名可被独立实现验证。

## 不能证明什么（如实标注）

- **DNC 命中是注入的 stub**：本机 gain-saas 运行实例未指向已合入 backend #896 的引擎进程；真实 `POST /outreach/dnc/check`
  的接线已由 11-1 单测与真实引擎端点覆盖，本演示只验证“命中后跳过并记录原因”的分支。
- **平台抑制同步使用记录器**：backend #896 尚未部署到本机运行实例，演示只验证发出的请求形状；真实跨租户抑制写入待 #896 部署后复验。
- **真实收件方 SPF/DKIM/DMARC 判定与进箱率**：`.test` 域不解析，需 D1② 真实域名后由 11-5 补。
- 真实 IMAP/webhook 入站接入未做；回复由 admin API 写入。

## 产物校验

```
decccab97baa921a390c52de61704b411261989edbbc3d56c9996a353be3f6ec  mailpit-raw.eml
d66702f1736b319dc3546f3fe1611891a494317f093c5fc24b752dec0513a978  dkim-public.b64
be5b37eb7ab345fd4d6a84d31a818440c059e154a1bcdfa05135fbe4be3b309a  dkim-verify-output.txt
92604390b23fa88c41cd6c0e242bdc4e0b2cfe9e3bcf283d1f0c317d447b62bf  demo-result.json
```

# M2 步 11-3 发送出口证据（TEST-ONLY，本机 sink）

日期：2026-11-08
范围：SMTP 执行器 → 本地 Mailpit sink；DKIM 本地签名与独立工具验证。
**不包含任何真实邮件外发**：出口白名单固定回环地址，发送总开关默认关闭。

## 环境

- Mailpit `axllent/mailpit:v1.27.4`（本机已有镜像），端口仅绑回环：
  `127.0.0.1:11025`（SMTP）/ `127.0.0.1:18025`（HTTP API）
- 测试发送域：`mail.gainos.test`（RFC 预留 `.test`，不解析）
- DKIM：`selector=test20261108`，RSA 2048，私钥只在 `/tmp` 临时目录，未入库；
  公钥见 `dkim-public.b64`（DKIM TXT `p=` 值）
- 验证器：dkimpy 1.1.8（独立实现），DNS 查询用注入的公钥替代真实 DNS

## 复现命令

```bash
docker run --rm -d --name gainos-mailpit-test \
  -p 127.0.0.1:11025:1025 -p 127.0.0.1:18025:8025 axllent/mailpit:v1.27.4

openssl genrsa -out /tmp/outreach-11-3-evidence/dkim-test20261108.key 2048
openssl rsa -in /tmp/outreach-11-3-evidence/dkim-test20261108.key \
  -pubout -outform DER | base64 -w0 > /tmp/outreach-11-3-evidence/dkim-public.b64

OUTREACH_DKIM_PRIVATE_KEY_PATH=/tmp/outreach-11-3-evidence/dkim-test20261108.key \
  pnpm --filter @gain-saas/server exec tsx scripts/outreach-smtp-sink-demo.ts

ID=$(curl -s http://127.0.0.1:18025/api/v1/messages \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['messages'][0]['ID'])")
curl -s "http://127.0.0.1:18025/api/v1/message/$ID/raw" -o mailpit-raw.eml

python3 -m venv /tmp/dkim-verify-venv
/tmp/dkim-verify-venv/bin/pip install dkimpy
/tmp/dkim-verify-venv/bin/python verify-dkim.py mailpit-raw.eml dkim-public.b64
```

验证脚本 `verify-dkim.py` 用 `dkim.verify(raw, dnsfunc=...)` 注入公钥，避免真实 DNS 查询；
这样验证的是**消息签名本身**，而不是 DNS 发布状态。

## 结果

- 投递：Mailpit 收到 1 封，`Message-ID: 01c46f24-b67d-4270-940e-598b3cf1998f@mail.gainos.test`
- DKIM：`dkim_verify: PASS`；查询名 `test20261108._domainkey.mail.gainos.test.`
- 原始邮件头见 `mailpit-raw.eml`，验证输出见 `dkim-verify-output.txt`

```
dkim_verify: PASS
dns_queries: ['test20261108._domainkey.mail.gainos.test.']
```

## 能证明什么

- 发送执行器能从配置的 SMTP 出口把单封纯文本邮件投递到本地 sink。
- DKIM relaxed/relaxed + rsa-sha256 签名可被独立实现验证通过（签名、正文哈希、头规范化均正确）。
- 出口白名单默认只允许回环；不在白名单时在连接前拒绝（单测覆盖）。
- DKIM 默认必需；缺私钥/缺域名/缺 selector 时拒绝发送（单测覆盖）。

## 不能证明什么（如实标注）

- 真实收件方的 SPF/DKIM/DMARC 判定与进箱率：`.test` 域不解析，需等 D1② 真实域名与 DNS 记录。
- 域名信誉预热、退信/投诉反馈回路。
- 这些属于 11-5，待域名到位后补。

## 产物校验

```
ba5aa688c9fcc5d7a3703eee1cf6079063b410a380a93fa1f5961eead7b4c0ce  mailpit-raw.eml
d66702f1736b319dc3546f3fe1611891a494317f093c5fc24b752dec0513a978  dkim-public.b64
be5b37eb7ab345fd4d6a84d31a818440c059e154a1bcdfa05135fbe4be3b309a  dkim-verify-output.txt
```

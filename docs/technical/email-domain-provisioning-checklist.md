# 发信域名与信箱开通清单（P4-12 / P4-13 前置）· v0

> 生命周期：`DRAFT`。用途：把「域名/DNS/信箱五件输入」变成可逐项勾选的执行单。
> **口径（2026-11-09 用户决定）**：生产发信身份是**客户自己的邮箱与域名**，平台不购买、不代持发信域；
> 本清单是「客户开通自有发信域时」的逐项执行/验收单，平台侧以本地 GreenMail 纯流程测试为准（#139）。
> 购买与 DNS 托管由客户（域名持有者）操作；其余步骤工程与运营均可自助完成。
> 依据：ch05 §5.3.3（域名策略/DNS 认证/暖场/种子测试）。

## 0. 客户侧需要人类操作的只有三件事

| # | 事项 | 谁 |
| --- | --- | --- |
| 1 | 注册/使用自己的发信域（见 §1） | 客户（域名持有者） |
| 2 | DNS 记录按 §2 逐条录入（Cloudflare 免费档等） | 客户（或授权运营） |
| 3 | Workspace 订阅与信箱创建（每域 2–3 个起） | 客户（付款） |

其余（记录核对、mail-tester/种子测试、`outreach_domain/outreach_mailbox` 入库、暖场阶梯、DMARC 收严）均可自助执行；
平台提供只读 DNS 自检脚本（§2）与入库 API（§3）。

## 1. 域名（客户自有；平台购域已暂缓）

> 2026-11-09 用户决定：生产发信使用**客户自己的域名与邮箱**，平台不购域。
> 下表仅是**平台自建演示域**时的命名参考；六个候选当日 Verisign RDAP 核查**全部 AVAILABLE**，
> 可用性随时间变化，注册前当日复查（`https://rdap.verisign.com/com/v1/domain/<domain>`，404=可用）。
> 客户侧接入时，D1 用客户自己的主发信域，D2/D3 视客户规模决定是否需要。

| 用途 | 命名参考 | 备注 |
| --- | --- | --- |
| D1 US/FR 生产主域 | `try-gainos.com` | 不用主域；从零 warmup |
| D2 第二生产域 | `gainos-outreach.com` | 独立 SPF/DKIM/DMARC |
| D3 catch-all 灰度域 | `gainos-test-mail.com` | 每域 ≤5 封/天、50–100 条小批 |
| D4/D5 备用 | `gainos-mail.com` / `trygainos.com` / `get-gainos.com` | 扩容或声誉受损时启用 |

## 2. DNS 记录（每域一份，精确值）

```dns
; SPF（Google Workspace）
<domain>.            TXT   "v=spf1 include:_spf.google.com ~all"
; DKIM（Admin 控制台生成 2048-bit，selector 以控制台为准，示例 google）
google._domainkey.<domain>. TXT "v=DKIM1; k=rsa; p=<控制台生成值>"
; DMARC 阶段 1（前 3 周）：仅观测
_dmarc.<domain>.     TXT   "v=DMARC1; p=none; rua=mailto:dmarc@<domain>; ruf=mailto:dmarc-forensics@<domain>; fo=1; adkim=r; aspf=r; pct=100"
; 阶段 2（第 3–4 周，门槛达标后）：隔离爬坡
; _dmarc.<domain>.   TXT   "v=DMARC1; p=quarantine; rua=mailto:dmarc@<domain>; adkim=s; aspf=s; pct=10"
; 阶段 3（第 5–6 周）：拒绝
; _dmarc.<domain>.   TXT   "v=DMARC1; p=reject; rua=mailto:dmarc@<domain>; adkim=s; aspf=s; pct=100"
; MX（Google Workspace）
<domain>.            MX    1 smtp.google.com.
```

核对命令（自助，只读，四项 `ready=true` 才算就绪）：

```bash
# cwd=apps/server；检查 SPF/DKIM/DMARC/MX 并输出 JSON（任一域未就绪退出码 2）
pnpm exec tsx src/scripts/outreach-domain-dns-check.ts try-gainos.com gainos-outreach.com
# 生成可直接粘贴到 DNS 服务商的记录模板（按本清单 §2，DMARC 阶段 1 生效）
pnpm exec tsx src/scripts/outreach-domain-dns-check.ts --template try-gainos.com
```

## 3. 信箱与暖场阶梯

| 阶段 | 每箱日上限 | 每箱周上限 | 动作 |
| --- | --- | --- | --- |
| W1（1–2 周） | 10 | 50 | 仅 warmup + 已知友好联系人 |
| W2（3–4 周） | 20 | 100 | 小批真实发送（≤10/箱/日）+ 每周种子 |
| W3（5–6 周） | 30 | 150 | 正常批次 + 种子 + DMARC 收紧准备 |
| MATURE（7 周起） | 40 | 200 | 稳定；扩容靠加信箱/加域 |

入库（自助，API）：

```bash
# 建信箱（AdminGuard 会话 cookie）
curl -X POST http://127.0.0.1:4020/api/outreach/mailboxes \
  -H 'content-type: application/json' \
  -d '{"address":"alex@try-gainos.com","displayName":"Alex Chen","warmupStage":"W1"}'
# 查看用量与阶梯上限
curl http://127.0.0.1:4020/api/outreach/mailboxes/usage
```

暖场供应商（只做暖场，不接管发送）：Instantly Growth / Mailreach（见 ch05 §5.3.3.3；采购前确认可独立运行）。

## 4. 上线前验收（每域）

1. mail-tester 10/10（免费 3 次/24h）；
2. 种子测试（GlockApps/InboxAlly 免费档起步）→ `POST /api/outreach/seed-tests` 记录；
3. DMARC rua 连续 4 周无未知发送源；
4. `GET /api/outreach/warmup/checklist` 显示 seedFresh/inboxOk/spamOk/mailboxesOk 四项全绿；
5. 在 `.env` 配置 `OUTREACH_SMTP_HOST/PORT/USER/PASSWORD/FROM_ADDRESS` 与 DKIM（私钥文件 0600）。

## 5. 发车次序（授权后）

1. 批次审批 → `POST /api/outreach/batches/:id/authorize` 签发 v2 授权；
2. `OUTREACH_SEND_ENABLED=true` 且 `CAMPAIGN_EXECUTION_SHADOW=false` 前，先用影子模式演练一轮（`SEND_SHADOWED` 事件核对）；
3. `OUTREACH_SENDER_ENABLED=true` 打开 job worker（批次队列自动消费）；
4. IMAP：安装凭据后 `OUTREACH_IMAP_ENABLED=true`，验证「取未读 → ingest → 标记已读」后关闭手工兜底。

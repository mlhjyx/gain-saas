# P4-12 配套决策记录：电话工具零采购先行、发信域名候选核查（2026-11-09）

分支：`claude/p4-12-dns`。用户 2026-11-09「你自己决定」授权下，代理对**零成本可决定**的剩余选项作出决定并落地；
**付款（域名/Workspace）与对外发车仍不由代理签字**，边界见 §3。

## 1. 电话工具：零采购先行（决定）

- **决定**：P4-10 电话试点不采购 Aloware 等外呼平台（$199/月起），先用普通 VoIP/手机拨号 + 本系统
  `outreach_call_basis` / `outreach_call_attempt` 台账（#137 已交付）。
- **理由**：P4 电话环节的目标是「每通电话有合规依据、有据可查、对方拒绝即停」，不是呼叫中心自动化。
  系统已具备：四问拨号依据、`validUntil ≤90 天`、号码 OPT_OUT 即停、outcome 闭集与审计。
- **何时重估**：日拨号量超过单人可管理规模、或需要录音合规存档/团队排队分配时，再评估外呼平台；
  接入只需在 `attempt.notes` 标注来源，不需要迁移数据模型。
- **话术与法审**：德语话术草案 `docs/technical/phone-script-de-draft.md`；法审按用户口径
  `OWNER_RISK_ACCEPTANCE` 自签（审计如实标注，非法务意见；`OUTREACH_LEGAL_REQUIRE_COUNSEL=true` 可恢复律师门）。

## 2. 发信域名候选：RDAP 只读核查（决定输入）

2026-11-09 用 Verisign RDAP（免费、只读）核查，六个候选**全部 AVAILABLE**：

| 候选 | 结果 | 角色 |
| --- | --- | --- |
| `try-gainos.com` | AVAILABLE | D1 US/FR 生产主域（首选） |
| `gainos-outreach.com` | AVAILABLE | D2 第二生产域 |
| `gainos-test-mail.com` | AVAILABLE | D3 catch-all 灰度/种子域 |
| `gainos-mail.com` | AVAILABLE | 备用 |
| `trygainos.com` | AVAILABLE | 备用 |
| `get-gainos.com` | AVAILABLE | 备用 |

核查方式：`https://rdap.verisign.com/com/v1/domain/<domain>`，HTTP 404 = 可注册。
**可用性随时间变化，注册当日需复查。**

配套工具（本 PR）：`apps/server/src/scripts/outreach-domain-dns-check.ts` —— 只读检查 SPF/DKIM/DMARC/MX
（`ready` 四项全真）并可生成 DNS 记录模板；用法见 `docs/technical/email-domain-provisioning-checklist.md` §2。

## 3. 边界：以下仍是用户的签字项（代理不做）

1. **付款**：域名注册（约 $10/年/个）与 Google Workspace 订阅（每信箱 $7/月起）需真实付款；
2. **对外发车**：打开 `OUTREACH_SEND_ENABLED` / `OUTREACH_IMAP_ENABLED`、换后端镜像是公开发布动作；
3. 电话试点名单与话术定稿（素材到位后录 `OWNER_RISK_ACCEPTANCE` 并激活）。

## 本机验证

```
apps/server outreach-domain-dns.spec.ts：7 tests 绿（四项齐备/缺 DMARC/TXT 分片/自定义 selector/解析失败/模板两例）
tsc --noEmit 绿；全量 server 套件回归见 PR 描述
```

## 不能证明什么

- 域名可用性只是当日快照，不锁定价格与所有权；
- DNS 检查脚本验证的是「记录存在且形态正确」，不验证投递声誉（那属于暖场与种子测试，P4-12 运营半边）。

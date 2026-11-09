# 德国电话话术（DE）· v0 草案

> 生命周期：`DRAFT` —— **未经德国律师书面意见前不得使用**（ch05 D5-11 发布门）。
> 使用前提：作为 `phone_script` 模板入库 → 提交法审 → 绑定 APPROVED 法审记录 → 激活（ACTIVE）；
> 每条拨号依据（`outreach_call_basis`）必须引用该 ACTIVE 版本（API 强制）。
> 默认不录音（§201 StGB 风险）；只记录结构化 outcome 与备注哈希。

## 1. 开场（≤15 秒）：身份 + 具体来意

> Guten Tag, hier ist **<Name>** von **<Firma>**.
> Ich rufe an, weil **<konkreter Bezug>** —
> z. B. „Sie haben auf der <Messe> am <Datum> an unserem Stand nach <Thema> gefragt"
> oder „Sie haben am <Datum> unser <Dokument> heruntergeladen".

规则：具体事实必须与 `outreach_call_basis.trigger_evidence` 一致；说不出具体事实就不拨。

## 2. 关联陈述（一句，≤20 秒）

> Wir helfen <Branche>-Unternehmen wie Ihrem dabei, **<konkretes Ergebnis>** —
> bei **<Firma>** geht es nach unserem Kenntnisstand um **<spezifisches Detail>**.

规则：禁止泛泛价值主张；`relevance_statement` 字段逐条手写同样内容（服务端 ≥20 字校验）。

## 3. 许可询问（关键：先要许可，再讲价值）

> Darf ich Ihnen dazu zwei Minuten eine Frage stellen?

拒绝处理：„Verstehe, danke für Ihre Zeit. Ich wünsche Ihnen einen guten Tag."
→ 立即记录 outcome=`OBJECTED`（objectionCode=`kein_interesse` / `keine_zeit`），**不再拨打**；
服务端自动写 phone 渠道 OPT_OUT（`OUTREACH_CALL_OBJECTED` 阻断后续拨号）。

## 4. 一个问题 + 一个价值点（≤60 秒）

> Wie lösen Sie heute **<Problem>**?

倾听后用一句对方行业的事实回应（不夸大、不承诺未验证的能力）。

## 5. 会议请求（二选一）

> Passt Ihnen eher **Dienstag um 10 Uhr** oder **Donnerstag um 14 Uhr** für 15 Minuten?

## 6. 结束与记录

| 情况 | 处理 |
| --- | --- |
| 同意会议 | 确认邮箱（仅用于会议确认，不进营销序列）；outcome=`CONNECTED_MEETING`；日历邀请 |
| 有兴趣但暂不约 | outcome=`CONNECTED_FOLLOWUP`；记录下一步 |
| 明确拒绝 / 要求不再来电 | outcome=`OBJECTED`，objectionCode=`nie_anrufen` → 永久压制 |
| 数据保护异议 | outcome=`OBJECTED`，objectionCode=`datenschutz` → 压制并转法务复核 |
| 号码错误 | outcome=`WRONG_NUMBER`（不压制，标记数据质量问题） |
| 前台/门卫 | outcome=`GATEKEEPER`（不压制；尝试获取正确联系人需新的依据） |

## 7. 异议应对话术（示例，待法审定稿）

- **kein Interesse**：„Verstehe. Darf ich Ihnen nur eine kurze Information per E-Mail schicken?"（**仅当已有邮件同意时**；否则不得转为邮件触达。）
- **haben schon**：„Danke, das wusste ich nicht. Worauf achten Sie bei der Auswahl?"（倾听一次，不纠缠。）
- **keine Zeit**：„Wann wäre ein besserer Moment für zwei Minuten?"（最多再约一次；被拒即 OBJECTED。）
- **Datenschutz**：„Selbstverständlich. Ich notiere, dass Sie keine weiteren Anrufe wünschen."→ 立即停止并压制。

## 8. 法审清单（律师逐项确认）

- [ ] §7(2) Nr.1 UWG：推定同意的证据标准与本话术是否匹配（BVerwG 2025-01-29，6 C 3.23）。
- [ ] DSGVO Art. 6(1)(f) 合法利益评估（LIA）与 Art. 14 告知路径。
- [ ] 录音禁止与记录口径（notes 哈希 + 对象存储）。
- [ ] 异议处理与 „nie_anrufen" 压制的法律充分性。

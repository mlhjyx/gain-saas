# 德国展会跟进 SOP（非邮件渠道）· v0 草案

> 生命周期：`DRAFT` —— 待产品负责人评审 + 德国律师按 UWG/DSGVO 书面意见后升 `APPROVED`（ch05 D5-11 发布门）。
> 适用范围：德国（DE）/奥地利（AT）展会线索的 T-6 至 T+7 跟进；**邮件仅限已取得 OPT_IN 的联系人**，
> 其余渠道走电话（逐条推定同意证据链）/ 纸质直邮 / 手工 LinkedIn（不带广告文案）。
> 依据：ch05 §5.3.4；UWG §7(2) Nr.1/2、OLG Hamm 2023-05-03（18 U 154/22）、BVerwG 2025-01-29（6 C 3.23）。

## 0. 铁律（违者停渠道）

1. **DE 冷邮件一律不做**（含 B2B）：只有 `outreach_consent` 存在 `OPT_IN`（source=fair_optin/inbound_form/customer_provided）的联系人才可进邮件序列。
2. **不做「先寄信/先电话再邮件」的绕行设计**（IHK 明确提醒）：渠道各自独立取合法依据。
3. **LinkedIn 不发广告私信**（含连接后）：只做关系维护与对方主动询问后的回复；连接请求不带销售文案。
4. **电话必须逐条有 `outreach_call_basis`**：合格事实（展会到访/表单/推荐/招标联系人）+ 具体关联陈述 + 证据 URL/时间；仅「行业相关」「黄页有号码」不合格（BVerwG 2025）。
5. **默认不录音**（§201 StGB）；只记录结构化 outcome 与备注哈希。

## 1. 时间轴与动作

| 阶段 | 动作 | 工具/数据 | 产出与验收 |
| --- | --- | --- | --- |
| T-6 周 | 拉官方展商名录/议程，按 ICP 选 20–30 家目标账户；**只买官方名录**，不买来源不明的 attendee list | 展会官方 provider + 人工筛选 | 目标账户表（官网/展位号/来源 URL） |
| T-4 周 | 对目标账户做 3 次定向触达：**电话（basis=公开采购/官网询盘等具体事实）或纸质明信片**；已有同意者用邮件 | 拨号清单 + 明信片模板（法审版） | 拨号记录（outcome）、明信片批次台账 |
| 展会日 | 按路线走展位；badge 扫描收集「同意后续联系」勾选；记录对话要点与下一步 | 手机表单（同意措辞法审版） | 每条线索：`outreach_consent(OPT_IN, source=fair_optin, evidence=badge/表单截图)` |
| T+0–48h | 对同意者发个性化跟进（提及展位对话）；**未同意者禁止导入邮件序列**，只能电话（basis=展位到访）或明信片 | 触达执行器（邮件）/ 拨号清单 | T+48h 跟进率 ≥90%（E5-08） |
| T+7 天 | 二次跟进（电话/资料）；无响应进入低频 nurturing（仅限有合法依据者） | — | 会议登记（CRM） |

## 2. 同意收集（展会现场，德语措辞待法审）

勾选框文案（占位，**法审后替换**）：

> 「Ich bin damit einverstanden, dass <Firma> mich per E-Mail zu <Produkt/Thema> kontaktiert. Diese Einwilligung kann ich jederzeit widerrufen.」

- 采集字段：勾选状态、时间戳、展会名/展位号、同意措辞版本号（`outreach_template_version` kind=consent_wording，状态必须 ACTIVE）。
- 写入：`outreach_consent(status=OPT_IN, source='fair_optin', lawfulBasis='explicit_consent', evidence={fair, booth, formRef})`。
- 撤回：任何回复/口头拒绝 → 立即写 `OPT_OUT`（reply ingest 或人工录入），跨 campaign 生效。

## 3. 电话证据链（与 P4-10 对齐）

每通电话前必须能回答四问，否则不许拨号：

1. 为什么打给这个人（具体事实）；
2. 事实与产品的具体关联（一句，禁模板化）；
3. 证据来源与取得时间（URL/展会/表单）；
4. 谁审过话术与理由（`legal_review` verdict=APPROVED，话术版本 `phone_script` 状态 ACTIVE）。

数据结构：`outreach_call_basis`（trigger_type/trigger_evidence/relevance_statement/collected_source_url/valid_until≤90 天）+ `outreach_call_attempt`（outcome 闭集/notes_hash）。**P4-10 施工时按 ch05 §5.3.4.2 建表**。

## 4. 角色与节奏

| 角色 | 负责 |
| --- | --- |
| 运营（1 人） | 名录筛选、拨号执行、badge 数据入库、T+48h 跟进执行 |
| 产品负责人 | ICP 与目标账户批准；法务预算；渠道停/启决定 |
| 律师（外部） | 同意措辞、明信片/邮件模板、拨号话术的书面意见（入库 `legal_review`） |
| 工程 | 执行器台账、同意写入、拨号 basis 校验、审计 SQL |

## 5. 验收与证据

- 跟进率：T+48h ≥90%（`outreach_consent.created_at` vs 展会结束时间）。
- 合规：DE 邮件零未同意（ch05 §5.3.2.3 审计 SQL = 0）；每通电话 100% 关联有效 basis；Abmahnung = 0。
- 证据归档：`docs/evidence/p4-fair/`（展会名录来源、badge 表单截图去标识化、拨号记录导出、审计 SQL 结果）。

## 6. 待办（阻塞项）

- [ ] 德国律师书面意见：同意措辞、明信片模板、拨号话术（外部，产品负责人安排）。
- [ ] 展会名录 provider 采购与账号（运营）。
- [ ] P4-10 建表与拨号 API（工程，待话术法审版本文本）。
- [ ] P4-11 工具化（展会后看板/SLA 计算）可在 P4-10 之后排期。

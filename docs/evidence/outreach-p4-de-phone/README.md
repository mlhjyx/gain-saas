# P4-10 DE 电话证据链：代码交付与待办（2026-11-10）

分支：`claude/p4-10-calls`。按用户指示「自己弄」推进代码可做部分；**话术文本与律师意见仍需外部素材**，
代码按 fail-closed 设计：法审/话术未就绪时无法建立任何拨号依据。不部署、不拨号。

## 交付清单

| 能力 | 实现 | 验证 |
| --- | --- | --- |
| 拨号依据表 | `outreach_call_basis`：triggerType 闭集（展会/询盘/老客户/公开采购/协会/推荐/采购公告）+ triggerEvidence JSON + **逐条手写 relevanceStatement（≥20 字）** + collectedSourceUrl/collectedAt + **validUntil ≤ 采集日+90 天** | `outreach-calls.service.spec.ts` 6 例 |
| 四问门 | 建依据时强制：话术必须是 **ACTIVE phone_script 模板**（`OUTREACH_CALL_SCRIPT_NOT_APPROVED`）；法审必须是 **APPROVED phone_script 记录**（`OUTREACH_CALL_LEGAL_REVIEW_REQUIRED`）；缺一不可 | 同上（负向用例） |
| 拨号记录 | `outreach_call_attempt`：attemptNo 递增、outcome 闭集（8 类）、objectionCode 闭集（5 类）、duration/notesHash；拨号前复查 basis 有效期与 phone 渠道 OPT_OUT | 同上 |
| 反对即停 | OBJECTED 或 objectionCode=nie_anrufen → 自动写 phone 渠道 OPT_OUT（channel='phone'），后续拨号返回 `OUTREACH_CALL_OBJECTED` | 同上 |
| API | `POST/GET /api/outreach/call-bases`、`GET /:id`、`POST/GET /:id/attempts`（写操作 AdminGuard） | 服务层测试；控制器为薄封装 |
| 话术草案 | `docs/technical/phone-script-de-draft.md`（DRAFT，**不得在律师意见前使用**） | 文档评审 |
| 错误文案 | 5 个电话族错误码登记中英三层 | `errors.test.ts` |

## 用户决定 2026-11-09：允许「负责人内部风险接受」自签

- 法审记录新增 `reviewerKind`：`LAWYER`（外部律师书面意见）/ `OWNER_RISK_ACCEPTANCE`（负责人内部风险接受，
  **审计如实记录、不冒充律师意见**）。默认门接受两种；`OUTREACH_LEGAL_REQUIRE_COUNSEL=true` 可随时恢复「必须律师意见」。
- 法律风险提示：发包人对「事先明示同意/推定同意」负举证责任；内部风险接受记录在 Abmahnung/诉讼中不具外部证据力。
  这是负责人的经营风险决定，代码保证的是「不伪装成律师意见、链路与审计可追溯」。

## 素材到位后的激活顺序（运营手册）

1. 律师书面意见（话术 + 推定同意标准）→ `POST /api/outreach/legal-reviews`（subjectKind=phone_script，verdict=APPROVED，documentHash=话术内容哈希）。
2. 以 `docs/technical/phone-script-de-draft.md` 定稿为 body → `POST /api/outreach/templates`（kind=phone_script）→ 提交法审 → 绑定上一步法审 → 激活。
3. 运营为试点联系人建立拨号依据（四问 + 证据 URL）→ 记录拨号 outcome。
4. 试点验收：30 天 ≥30 通有效对话、≥3 会议、0 Abmahnung（ch05 E5-07）。

## 本机验证

```
apps/server outreach：口径见 PR（新增 calls spec 6 例）
tsc --noEmit 绿；迁移 20261110220000_outreach_call_basis 一次性库全链通过
```

## 不能证明什么 / 仍需外部输入

- **法审按用户决定走自签**：以 `OWNER_RISK_ACCEPTANCE` 记录激活话术模板即可建依据；若切回律师门（REQUIRE_COUNSEL=true），
  则仍需律师书面意见（话术为 DRAFT，届时无法激活）。
- **电话工具未选型**（Aloware 3 用户包 vs 普通 VoIP）：当前 API 是工具无关的台账（CSV/手工录入均可用），选型不阻塞代码。
- **无真实试点名单与拨号**：需运营提供展会/询盘名单后执行（可自行采集，见 fair SOP）。

## 顺带解决（P4-13 部分）

`imapflow@2.11.0` 已安装入 `apps/server/package.json`（pnpm-lock 同步），IMAP 轮询适配器改为静态类型导入；
`OUTREACH_IMAP_ENABLED` 仍默认 false，发车门槛剩：真实信箱凭据 + 「取未读→ingest→标记已读」验收 + 多信箱 secret_ref 化。

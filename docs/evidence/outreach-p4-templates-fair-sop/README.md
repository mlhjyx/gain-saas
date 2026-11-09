# P4 第五波：模板版本化（P4-05 占位）与德国展会 SOP（P4-11 docs 版，2026-11-10）

分支：`claude/p4-05-templates`。不部署、不发真实邮件；本次不含任何运行时开关变化。

## 交付清单

| 能力 | 实现 | 验证 |
| --- | --- | --- |
| 法审记录（P4-05 占位） | `legal_review`：subjectKind（email_template/phone_script/consent_wording/lia_letter）、documentHash、律师/律所/日期/范围/verdict（APPROVED/CONDITIONS/REJECTED）/意见书引用；写入 AdminGuard，列表租户可见 | `outreach-templates.service.spec.ts`（校验/过滤/跨租户） |
| 模板版本化 | `outreach_template_version`：kind×jurisdiction×language 按组递增版本；**新版本默认 DRAFT（不生效）**；`contentHash` 为内容快照；DRAFT→LEGAL_REVIEW→APPROVED→ACTIVE→RETIRED；激活需绑定 **APPROVED 且哈希一致、类型匹配**的法审记录；激活自动退役同组旧 ACTIVE；`activeFor()` 供未来序列引擎只读 ACTIVE | 同 spec 5 例（版本递增/哈希变化/全生命周期/五类跳步负向） |
| 德国展会 SOP（P4-11 docs 版） | `docs/technical/fair-followup-sop-de.md`：T-6/T-4/T0/T+48h/T+7 动作表、同意收集措辞（占位，待法审）、电话四问证据链、角色分工、验收与证据、待办阻塞 | 文档评审（产品负责人 + 德国律师） |

## 本机验证

```
apps/server outreach：23 files / 199 tests 绿（新增模板 spec 5 例）
tsc --noEmit 绿；packages/shared 39 tests 绿
迁移：一次性库 prisma migrate deploy 全链通过（20261110190000_outreach_templates_legal_review，additive）
```

## 语义与边界

- **模板默认不生效**：DRAFT 只是内容快照；任何发送/序列链路（未来 P4-05 引擎）只读 ACTIVE，无 ACTIVE 时 fail-closed（不回落旧版）。
- 法审是**占位**：真实律师意见与文案按 D5-11 由产品负责人安排；CONDITIONS/REJECTED 记录可入库但不可用于激活。
- SOP 是 DRAFT：邮件相关段落只在「已有 OPT_IN」前提下适用；德国冷邮件保持禁止。

## 不能证明什么

- 无任何真实模板被激活（法审素材未到）；本 PR 只证明状态机与哈希绑定正确。
- SOP 未经律师审阅，德语同意措辞为占位文本，不得直接上线使用。

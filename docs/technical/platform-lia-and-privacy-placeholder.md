# 平台合法依据（LIA）与隐私文本 · 更新占位

> 文档 ID：`DOC-TECH-PLATFORM-LIA-PRIVACY-PLACEHOLDER-001`
> 生命周期：`DRAFT`
> 状态：占位稿——正式法务文本由产品负责人签字后替换本文
> 依据：`/global/backend/docs/superpowers/plans/2026-11-04-acquisition-system-complete-design.md` §7.4（2026-11-04 决策「取消租户声明」，Q23–Q25）

## 1. 生效口径（工程事实，2026-11-04 起）

- **取消租户数据处理声明**：设置页「数据处理声明」入口已下架，写入接口下线（`PUT /api/settings/compliance` → 410
  `COMPLIANCE_DECLARATION_RETIRED`）；历史声明只读留存（`GET /api/settings/compliance` 返回 `platform` + `declarations`）。
- **平台级合法依据**：BFF 对三个联系人操作路由（discover-contacts / guess-emails / verify）统一注入
  `lawfulBasis: legitimate_interest`、`lawfulBasisRef: OWNER-DECISION-2026-10-11`
  （与引擎 run 内联系人阶段的 interim LIA 同一引用）。引擎请求级字段、校验与审计（`stampLawfulBasis`）不变。
- **补偿控制**：个人数据每次访问/物化写访问审计（谁/何时/公司/字段类/用途），保留 180 天；DSR 擦除链不变。

## 2. 待法务/产品负责人签字的文本（占位）

以下条目需要正式文本，签字后替换本节，并把本文生命周期改为 `GUIDE`（或由产物文档取代）：

1. **隐私政策更新**：个人数据的处理目的（B2B 获客：公司公开信息与工作相关个人数据的发现、验证与联系）、
   数据类别、来源（公开网页/官方注册库/展会名录/客户导入）、保存期限（原始记录按源策略；个人字段 180 天滚动；
   访问审计 180 天）、数据主体权利与行使渠道（DSR 入口：设置 → 数据与隐私）。
2. **平台 LIA（合法利益评估）摘要**：目的测试、必要性测试、利益权衡（对数据主体的影响与保障措施），
   引用 `OWNER-DECISION-2026-10-11` 作为当前平台口径；如正式 LIA 编号不同，需同步更新 BFF 常量
   `PLATFORM_LAWFUL_BASIS.ref`（`apps/server/src/bff/routes.ts`）。
3. **EU 触达限制说明**：德国等 EU 市场仅生成联系草稿、不自动发送（UWG §7 事先同意要求），随触达阶段（M3）上线。

## 3. 未做（本占位不含）

- 正式法律文本的最终定稿与公示位（落地页/注册页链接）——由产品负责人安排。
- 租户声明的恢复路径：引擎合同未变，随时可恢复「租户声明」模式；恢复时需重新提供写入入口并把
  BFF 注入切回声明快照（见 git 历史 2026-11-03 版本）。

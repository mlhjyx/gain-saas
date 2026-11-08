# M2.0 · Campaign 控制面最小域 · 契约先行（CampaignPlan v0）

> 文档 ID：`DOC-TECH-CAMPAIGN-CONTROL-PLANE-M2-0-001`
> 生命周期：`APPROVED`
> 生命周期依据：产品负责人 2026-11-08 批准 D-i1~D-i4 全部按推荐值（范围=契约+表+API+状态机+测试；自审允许留痕；TTL 72h/30min/1；verify 端点 v0 建、引擎接入延后），并批准施工。
> 最后核验：2026-11-08
> 上游依据：计划 v1.5 §0.2 步 9（M2.0/M2.1/M2.2 拆分）、§18.4 P0-2（Campaign 控制面最小域）、§0.7 D-MA-3（受限规划器）、D-MA-8（决策轨迹与审批规格并入 M2.0 契约）、§0.7-F2（审批状态机与轨迹字段组）；PRD v3.0 §7.6 / §9.13 / §9.15。
> 范围声明：M2.0 = 契约 + 表 + 最小 API + 状态机 + 测试，**不含** UI、LLM、引擎改动；M2.1（受限 Campaign Planner shadow + 审批 UI 端到端）与 M2.2（有界重规划 + 指标）另文。

## 1. 背景与目标

- PRD 对照评估（计划 §18.2 第 6 行）：「引擎与 gain-saas schema 均无 Campaign/Audience/Goal/Initiative/ExecutionAuthorization 模型；无对应 API」——**能力 2 是最大真实缺口（P0）**；顶层架构称「最危险的不是缺视频/多平台，而是合格 Lead 之后没有 Campaign、受控触达、QGO 与结果回写」。
- 已批决策 D-MA-3 把 M2 拆成三步：**M2.0 契约先行**（「计划即数据」）、M2.1 受限规划器（propose-only、shadow 2–4 周）、M2.2 有界重规划 + golden set。D-MA-8 要求把 F2 的决策轨迹字段组与审批状态机**并入 M2.0 契约与执行链验收**。
- M2.0 要钉死的四件事：
  1. **CampaignPlan 是可校验、可哈希、可审批、可追溯的不可变数据**（不是自由文本、不是 prompt）；
  2. **审批以 revision（plan_hash）为单位**，范围变化必须重审（F2：旧同意不可复用）；
  3. **双钥匙模型落契约**：Grant 管钱（引擎执行预算账户），ExecutionAuthorization 管动作边界（业务动作的短期授权）——两者独立签发、独立校验（ADR-0001）；
  4. **决策轨迹是一等数据**（append-only），为 M2.1 审批 UI 与前端「过程」页供数。

## 2. 承重假设（可证伪，错了会改设计）

| # | 假设 | 若被证伪 |
| --- | --- | --- |
| A1 | 审批单元=revision，approval/authorization 都绑定 `plan_hash`，任何字段变更产生新 revision 并使旧同意失效 | 改回「campaign 级审批」，但 F2 明令反对（范围变化必须重审） |
| A2 | Grant（钱）与 ExecutionAuthorization（动作边界）是两个签名物，互不替代 | 合并进 Grant → 引擎验证合同大改，跨仓风险高（见 §10 备选） |
| A3 | M2.0 纯 gain-saas 域内可闭环（API + 表 + 状态机 + 测试），不触引擎、不触前端 | 若审批必须前端才能验收 → 提前拉 M2.1 的 UI 最小页 |
| A4 | audience 明细可整体放在 plan JSON 里，单独建 `campaign_audience` 表**只存规范化引用与规模参数**（icp_ids / filters / size_cap），不做估算 | 若 M2.1 规划器需要按 audience 维度查询/复用 → 扩表字段（additive，代价小） |

## 3. 域模型（Prisma · additive · 无回填）

所有表：`workspace_id` 必填 + 索引；UUID 主键（`@default(uuid()) @db.Uuid`）；字段与表名风格沿用本仓既有约定（camelCase 字段 / snake_case `@@map`）。

### 3.1 `campaign`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| workspace_id | uuid, idx | 租户边界 |
| name | text | 业务名称 |
| objective | text | 目标（人话；结构化指标在未来 revision 里） |
| status | enum `CampaignStatus` | `DRAFT / ACTIVE / PAUSED / ARCHIVED`（ACTIVE 需存在 APPROVED revision 且有有效 authorization 概念后才可置位；M2.0 只在 API 校验） |
| current_revision_id | uuid? | 指向最新 revision（FK 后置，避免循环约束：用普通列+应用层校验） |
| created_by / updated_by | text | 用户 id |
| created_at / updated_at | timestamptz | |

### 3.2 `campaign_revision`（不可变）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| workspace_id | uuid, idx | |
| campaign_id | uuid, idx | FK → campaign (cascade) |
| revision_no | int | 同一 campaign 内单调递增；`@@unique([campaignId, revisionNo])` |
| plan | jsonb | **CampaignPlan v0 原文**（§4） |
| plan_hash | text | canonical JSON 的 sha256（§4.3）；`@@index([workspaceId, planHash])` |
| state | enum `RevisionState` | `DRAFT / SUBMITTED / APPROVED / DECLINED / EXPIRED / SUPERSEDED` |
| created_by | text | |
| created_at | timestamptz | |

规则：revision 创建即不可变（除 `state` 迁移）；任何修改 = 新 revision。新 revision 提交时，上一已批准 revision 置 `SUPERSEDED`。

### 3.3 `campaign_audience`（revision 1:1）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| workspace_id | uuid, idx | |
| revision_id | uuid, unique, FK → campaign_revision (cascade) | |
| icp_ids | jsonb | 引擎 ICP 引用数组（uuid 字符串） |
| include_filters | jsonb? | 结构化筛选（国家/行业/规模等，v0 原样存） |
| exclude_filters | jsonb? | 排除条件（含禁联名单引用位，执行时再展开） |
| size_cap | int | 本轮目标公司数上限（env 上限校验） |
| created_at | timestamptz | |

### 3.4 `campaign_approval`（状态机主体）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| workspace_id | uuid, idx | |
| revision_id | uuid, idx, FK → campaign_revision | |
| plan_hash | text | 冗余绑定（防 revision 行被误改）；审批只对该 hash 有效 |
| state | enum `ApprovalState` | `PENDING / APPROVED / DECLINED / EXPIRED` |
| requested_by | text | 提交人 |
| decided_by | text? | 审批人（admin/owner） |
| decided_at | timestamptz? | |
| decision_reason | text? | |
| expires_at | timestamptz | 默认 +72h（env `CAMPAIGN_APPROVAL_TTL_HOURS`） |
| created_at | timestamptz | |

规则（F2，写进状态机并由测试固化）：
- `approve` 与 `decline` 同权（均为 admin/owner 角色）；
- **超时=拒绝**：`decide()` 时发现 `expires_at < now()` → 该 approval 先迁移 `EXPIRED` 并拒绝本次操作（409 `CAMPAIGN_APPROVAL_EXPIRED`）；读取面同样做惰性投影；
- **旧同意不可复用**：approve 后若产生新 revision，旧 approval 归 `SUPERSEDED`（revision 状态），新提交必须走新审批；
- **范围变化必须重新审批**：authorization 校验时 `plan_hash` 不匹配即拒绝；
- 自审（requested_by == decided_by）：**允许但留痕**（v0 单成员工作空间是常态；decision trace 记录 `self_approval=true`，M2.1 UI 显示提示并统计橡皮图章率）。

### 3.5 `execution_authorization`（动作边界授权）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | |
| workspace_id | uuid, idx | |
| campaign_id | uuid, idx | |
| revision_id | uuid | |
| plan_hash | text | 绑定的计划指纹 |
| scope | jsonb | 允许的动作清单：`{actions:[{type:'discovery.run', icpIds:[...], maxRuns?}], sizeCap}`（v0 仅 discovery.run） |
| token | text | 签名令牌（HS256 JWT，`SigningKey` 复用；claims 见 §6.3） |
| state | enum `AuthorizationState` | `ISSUED / CONSUMED / EXPIRED / REVOKED` |
| max_uses / uses | int, int | v0 默认 max_uses=1（一次执行）；`uses` 由消费方回报（M2.1） |
| issued_at / expires_at | timestamptz | TTL 默认 30 分钟（env `CAMPAIGN_AUTHZ_TTL_MINUTES`） |
| revoked_at / revoked_reason | timestamptz? / text? | 撤销（workspace 停用联动 + 手动撤销） |
| created_at | timestamptz | |

### 3.6 `campaign_decision_trace`（append-only，D-MA-8 / F2 字段组）

| 列组 | 列 | 说明 |
| --- | --- | --- |
| 执行上下文 | id, workspace_id(idx), campaign_id(idx), revision_id?, trace_id(idx), parent_trace_id?, step_type, actor, actor_type(`user/service/ai`), workflow?, workflow_version?, attempt, created_at | 对应 F2「trace/run/parent/step_type/actor/workflow+version/时间/attempt」 |
| 决策与依据 | decision_type, gate?, policy_version?, chosen_option?, score?, reason_code?, evidence jsonb[], rejected_candidates jsonb[] | evidence 元素 `{url, retrievedAt, support}`；被否候选 `{candidateRef, score, rejectReason, revivable}` |
| 成本 | cost_estimated_micros?, cost_actual_micros?, budget_domain?, budget_remaining_micros? | 预估 vs 实际 |
| 审批 | approval_state?, approval_id? | 审批链快照 |

纪律：只允许 INSERT；不给 UPDATE/DELETE 的 API 与服务方法（DB 层不加触发器，代码评审+负向测试守卫，与 F2 的 append-only 语义一致）。M2.0 写入点 = 审批流程（提交/批准/拒绝/过期/签发/撤销）；规划器轨迹在 M2.1 接入同一张表。

## 4. CampaignPlan v0 契约

### 4.1 结构（zod v4 定义，`z.toJSONSchema()` 导出 `campaign-plan.v0.schema.json` 供外部校验与文档）

```
CampaignPlanV0 {
  schemaVersion: 'campaign-plan/v0'
  goal: { objective: string(1..500), successMetric?: string(0..200) }
  audience: { icpIds: uuid[1..20], includeFilters?, excludeFilters?, sizeCap: int(1..1000) }
  motions: [{ type: 'discovery', icpIds: uuid[], }]            // v0 仅 discovery；outreach 位保留枚举但拒绝
  budget: { capMicros?: int>=0, currency: 'USD' }               // 与 workspace 配额上限做 service 层校验
  schedule: { notBefore?: ISO8601, notAfter?: ISO8601 }
  approvalPolicy: { required: true }                            // v0 恒 true
  decisionPolicy: { maxReplans: 0 }                             // M2.2 起允许 {0,1,2}；旧 0 仍合法
}
```

### 4.2 校验分层

1. **结构校验**（zod）：字段/类型/边界/枚举，错误码 `CAMPAIGN_PLAN_INVALID`，`details.issues[]` 逐项带 path/message；
2. **语义校验**（service，读库）：`audience.icpIds` 与 `motions[].icpIds` 必须 ⊆ audience.icpIds；`sizeCap ≤ env CAMPAIGN_AUDIENCE_SIZE_CAP_MAX`（默认 1000）；`budget.capMicros ≤ workspace_budget_policy.max_spend_micros`（若 policy 存在且启用）；ICP 权属校验在 M2.1 接引擎后补（v0 记录为**已知边界**，见 §11）。
3. **指纹**：`plan_hash = sha256(canonicalize(plan))`；canonicalize = 递归按键名 UTF-16 码点排序后 JSON 序列化（RFC 8785 JCS 等价子集；不引入新依赖）。浮点/NaN/时间对象一律拒绝（schema 层面已限制为字符串/整数）。

### 4.3 版本化

- schemaVersion 是**契约版本**；不兼容变更=新版本号（v1），并存双版本校验器一个发布周期。M2.0 只实现 v0。

## 5. 状态机总览

```
revision:    DRAFT → SUBMITTED → APPROVED | DECLINED | EXPIRED
                     └→ (新 revision 提交时) 旧 APPROVED → SUPERSEDED
approval:    PENDING → APPROVED | DECLINED | EXPIRED        （超时=拒绝，decide/读取时惰性投影）
authorization: ISSUED → CONSUMED | EXPIRED | REVOKED       （REVOKED 来源：workspace 停用联动/手动）
```

非法迁移一律 409，错误码表见 §6.4。

## 6. API（BFF · code-first · 全部 workspace 作用域）

### 6.1 租户端点（TenantGuard；写操作要求 `role=admin`）

| 方法/路径 | 说明 | 错误码要点 |
| --- | --- | --- |
| `POST /api/campaigns` | 建 campaign（name/objective） | 校验失败 400 |
| `GET /api/campaigns` | 列表（含最新 revision 状态摘要） | |
| `GET /api/campaigns/:id` | 详情（revisions + approvals + authorizations + 最近 trace） | 跨租户 404 |
| `POST /api/campaigns/:id/revisions` | 提交新 plan：结构+语义校验 → revision_no+1（state=DRAFT） | `CAMPAIGN_PLAN_INVALID` |
| `POST /api/campaigns/:id/revisions/:revId/submit` | DRAFT→SUBMITTED，建 approval(PENDING)，旧 APPROVED→SUPERSEDED | 409 非法状态 |
| `POST /api/campaigns/:id/approvals/:approvalId/decide` | `{decision:'approve'|'decline', reason?}`；approve → revision=APPROVED + 签发 authorization | `CAMPAIGN_APPROVAL_EXPIRED / ALREADY_DECIDED / VERSION_CONFLICT` |
| `POST /api/campaigns/:id/authorizations/:id/revoke` | 手动撤销 | |
| `GET /api/campaigns/:id/trace` | 决策轨迹（分页） | |

### 6.2 服务端点（服务身份；给引擎/M2.1 用）

| 方法/路径 | 说明 |
| --- | --- |
| `POST /internal/execution-authorizations/verify` | `{token, planHash, action:{type, icpIds?}}` → `{valid, reason?}`：验签+过期+状态+hash/gate 匹配。v0 在本仓实现并有单测；引擎接入在 M2.1/步 9b。是否暴露 HTTP 由 M2.1 定，M2.0 先提供模块内函数 + 端点（端点挂服务 token 守卫，与既有 r4 服务模式一致）。 |

### 6.3 Token 设计

- HS256 JWT，`SigningKey`（现有表/轮换模式）签发；claims：`{sub: authorizationId, wsu: workspaceId, camp, rev, ph: planHash, scope, exp, iat, jti}`；
- 校验顺序：签名 → exp → DB 状态（ISSUED）→ workspace ACTIVE → plan_hash/gate 匹配 → uses < max_uses；
- 不透明 ID + 服务端查表也足够安全，JWT 的价值是引擎**无状态预检**；两者结合（JWT 快检 + DB 复核消费）。

### 6.4 错误码表（节选）

`CAMPAIGN_PLAN_INVALID` / `CAMPAIGN_REVISION_STATE_CONFLICT` / `CAMPAIGN_APPROVAL_EXPIRED` / `CAMPAIGN_APPROVAL_ALREADY_DECIDED` / `CAMPAIGN_APPROVAL_NOT_PENDING` / `CAMPAIGN_AUTHORIZATION_INVALID` / `CAMPAIGN_AUTHORIZATION_EXPIRED` / `CAMPAIGN_AUTHORIZATION_REVOKED` / `CAMPAIGN_NOT_FOUND`（跨租户同此码，404）。

### 6.5 审计

全部写操作落 `audit_log`（realm=tenant，action=`campaign.created / revision.created / revision.submitted / approval.decided / authorization.issued / authorization.revoked`），detail 含 plan_hash 与 approval/authorization id。

## 7. 事件与闭环位置

- **对外事件暂缓成型**：gain-saas 目前只有 EventInbox（消费引擎事件），没有对外 outbox 管道；M2.0 不造空管道（「孤立功能不立项」的反面同样适用）。跨服务契约先以 §6.2 的验证端点表达；`campaign.*` 版本化事件在 M2.1 引擎侧真正消费时再建（届时随 planner 一起设计 idempotency key）。
- **闭环位置**（计划 §17.9 十二阶段）：Plan → Approve 两段；上游接 Target（ICP 引用），下游接 Execute（M2.1/9b 用 authorization 放行 `discovery.run`）。端到端演示（M2.0 内）：建 campaign → 提交 plan → 审批通过 → 取得 authorization → 用 verify 证明有效 → revoke 后 verify 失败。
- **与 Grant 的分工（ADR-0001 摘要）**：Grant 回答「这笔钱能不能花」（引擎预算账户、fence、ACK）；ExecutionAuthorization 回答「这个动作准不准做」（业务边界：哪个 ICP、多大范围、到何时）。执行 discovery.run 时两者都要：BFF 先验 authorization 再签 Grant（M2.1 接线）。

## 8. 安全与合规

- 租户隔离：所有查询 `workspace_id` 过滤 + 跨租户 404 测试（沿用现有 BFF 模式，本仓无 RLS，与既有表一致）；
- 审批权限：admin/owner；自审允许但 trace 记录（§3.4）；
- workspace 停用/归档：TenantGuard 拦截全部新请求；**联动撤销**所有 `ISSUED` authorization（在 workspace 状态迁移处调一次 `revokeAllForWorkspace`，复用既有停用路径）；
- 数据最小化：trace/plan 不含个人数据（联系人只在执行产物里，归引擎侧既有合规口径）；
- 删除：campaign 不做物理删除（v0 无删除端点）；DSR 级联在 M2.1 与引擎对象绑定后一并定义（开放问题 Q-4）。

## 9. 测试与 TDD 步骤（RED→GREEN）

1. validator 单测：每个字段边界 + 每个错误码（表驱动）；
2. canonicalize/plan_hash：键序无关、数值/时间拒绝、跨平台稳定向量；
3. 状态机单测：提交→批准→签发；decline；expired（decide 时惰性）；double-decide 409；新 revision 使旧批准 SUPERSEDED；hash 不匹配 verify 失败；
4. token：签发/验签/过期/篡改；verify 端点负向（跨租户、revoked、used-up）；
5. 跨租户 404 集成测试；audit_log 行断言；trace append-only（无 update 方法 + 负向测试）；
6. workspace 停用联动撤销测试；
7. `gctl`-等价的仓内门：typecheck + vitest + prisma migrate diff 干净。

## 10. 备选方案与否决理由

| 备选 | 否决理由 |
| --- | --- |
| Campaign 放引擎（backend） | 与 PRD/§18.4 所有权相反；引擎是执行器不是业务 SoR；跨仓验证链每步都要动 R4/Grant 合同 |
| 审批逻辑塞进 Grant（campaignCap/maxRuns） | Grant 是平台钱的合同（引擎强制 campaignCap=null），且「动作边界」与「钱」生命周期不同（钱按 run，授权按动作窗口）；混在一起改跨仓签名合同风险高 |
| 先做 UI/规划器再补契约 | 「计划即数据」不先行 → UI 先绑死字段，M2.1 规划器二次返工；F2 明确轨迹/审批语义必须先定 |
| 独立 outbox 事件管道（v0） | 无消费方的管道是死代码；M2.1 设计消费方时一并建 |

## 11. 已知边界与开放问题

- **Q-1 审批 TTL**：默认 72h（env 可调）；
- **Q-2 authorization TTL / max_uses**：默认 30min / 1（一次执行一个批次）；
- **Q-3 size_cap 上限**：默认 1000（env）；
- **Q-4 DSR/删除级联**：v0 无物理删除；M2.1 与引擎执行对象绑定后定义（沿用 deletion workflow 模式）；
- **Q-5 ICP 权属校验**：v0 只做格式校验，真实权属在 M2.1 经引擎查询补；
- **Q-6 自审**：允许+留痕（如产品侧要求禁止，改一条规则即可）。

## 12. 迁移与回滚

- 一条 additive 迁移（6 张表 + 枚举 + 索引），无回填、无既有表变更；
- 回滚：不部署新代码即可（表保留无害）；端点未接前端/引擎前无行为变化；
- 发布：常规 `prisma migrate deploy`（随发布列车），**无引擎/镜像联动**。

## 13. 给产品负责人的说明

- **得到什么**：Campaign 控制面的数据契约与最小域——「计划」从此是可审批、可追溯的结构化对象；M2.1 规划器与审批 UI、步 10 QGO 都有地基；Grant 与动作授权的边界写进 ADR，后续受控触达（步 11）不再临时发明授权机制。
- **没改什么**：引擎零改动、前端零改动、现有 run/额度/审计行为不变；不加任何对外事件管道。
- **风险与回退**：新增表 additive，回退=不部署；唯一产品语义风险是审批规则（超时=拒绝、自审允许留痕），已按已批 F2/D-MA-8 落，改动成本一条规则。
- **建议**：按本文档施工（2 个 PR：PR-1 契约+ADR；PR-2 表+API+状态机+测试）；自审规则按「允许+留痕」起步，M2.1 UI 上线后看橡皮图章率再收紧。
- **本次要批的决策点**：D-i1 施工范围=§范围声明；D-i2 自审=允许+留痕；D-i3 TTL 默认值（72h/30min/1 次）；D-i4 verify 端点 v0 建但引擎接入延后。

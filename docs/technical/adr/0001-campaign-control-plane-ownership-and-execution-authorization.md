# ADR-0001 · Campaign 控制面所有权与「双钥匙」执行授权

> 文档 ID：`DOC-ADR-GAIN-SAAS-0001`
> 生命周期：`PROPOSED`
> 最后核验：2026-11-08
> 关联：`docs/technical/campaign-control-plane-m2-0.md`（M2.0 设计）；计划 v1.5 §18.4 P0-2、§0.7 D-MA-3/D-MA-8；PRD v3.0 §7.6/§9.13/§9.15。

## 状态

Proposed（随 M2.0 设计一并评审；合入即 Accepted）。

## 背景

1. PRD 对照评估确认 Campaign/Audience/Approval/ExecutionAuthorization 全域缺失，是能力序列里的最大 P0 缺口；顶层架构把「合格 Lead 之后没有 Campaign/受控触达/QGO/结果回写」列为最危险断点。
2. 引擎已有执行预算 Grant（钱：预算账户、fence、ACK、撤销链，R4 权威），但**没有任何业务动作授权层**——「这笔钱能花」不等于「这个动作准做」。
3. 若把动作授权塞进 Grant：引擎的 Grant 合同强制 `campaignCap=null && maxRuns=null`（平台专属字段），跨仓改签名合同+验证器+镜像的代价高，且钱的生命周期（按 run）与动作边界（按审批计划快照）不同。
4. 若 Campaign 放引擎：与「业务 SoR 在 Growth Core（gain-saas）」的既定分层相反；引擎是执行器，不应拥有业务计划生命周期。

## 决策

1. **所有权**：Campaign 控制面（Campaign / Audience / Revision / Approval / ExecutionAuthorization / DecisionTrace）归 **gain-saas（Growth Core）**，是这六类对象的唯一 SoR。引擎只持有执行侧引用（plan_hash、authorization id）。
2. **双钥匙模型**：任何受控外部/付费动作在执行前必须同时满足：
   - **Grant**（引擎）：这笔钱可花——预算账户、执行围栏、幂等与撤销链，**归平台权威**；
   - **ExecutionAuthorization**（gain-saas 签发）：这个动作准做——绑定 `plan_hash`（审批过的计划指纹）+ 动作范围（如 `discovery.run` + ICP 集 + size_cap）+ 短 TTL + 有限次数；引擎执行前校验（M2.1 接入），令牌用现有 `SigningKey` 签发（HS256 JWT）。
3. **审批状态机**（F2 / D-MA-8）：审批单元 = revision（plan_hash）；approve/decline 同权；超时=拒绝；旧同意不可复用；范围变化必须重新审批；决策轨迹 append-only（三类字段组：执行上下文 / 决策与依据（含被否候选）/ 成本与审批链）。
4. **不引入第二编排器、不加对外事件管道（v0）**：跨服务契约先以验证端点表达；`campaign.*` 事件在 M2.1 有真实消费方时再建。

## 后果

- 正向：M2.1 规划器、审批 UI、步 11 受控触达、步 10 QGO 均有稳定地基；钱与动作的审计链分离，事件可分别归因；引擎侧无需改 Grant 合同。
- 代价：执行一个动作需要两次校验（多一跳验证调用）；plan_hash 变更会使旧授权失效——这是刻意行为（F2 要求），但要求调用方在重规划后重新走审批。
- 失效模式与对策：authorization 泄漏→短 TTL+单次使用+可撤销；approval 橡皮图章→trace 记录自审与决策时长，M2.1 UI 统计；plan JSON 演化→schemaVersion 并存双校验器一个发布周期。

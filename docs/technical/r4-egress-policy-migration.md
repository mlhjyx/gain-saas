# P3d：把 egress 策略的生成与安装迁到 gain-saas

> 文档 ID：`DOC-SAAS-TECH-R4-002`
> 生命周期：`APPROVED`（产品负责人 2026-10-31 批准方向，按 §7 实施）
> 制定日期：2026-10-31
> 依据：产品负责人 2026-10-31 决定「egress 策略迁到 gain-saas 生成」，见
> [R4 迁移计划](r4-platform-authority-migration.md) §4.1
> 现状核验：2026-10-31，`global_dev.platform_egress_schedule_fence` 三行 ACTIVE

## 1. 现状

| 项 | 事实 |
| --- | --- |
| 存储 | 引擎库表 `platform_egress_schedule_fence`（每 schedule 一行） |
| 安装入口 | DB 函数 `install_platform_egress_policy_v2(schedule, expected_generation, policy_artifact_sha256, execution_envelope_sha256, required_cap_microusd)`，以**库 owner** 身份执行 |
| 值的来源 | 后端报价实现（`PlatformExecutionTechnicalQuoteService`）：artifact 摘要全 schedule 相同（`f9e95917…`），envelope 摘要每个 schedule 不同，`required_cap_microusd` 分别是 1 / 10 000 000 / 1 |
| 当前状态 | acq-sweep、intent-sweep、sanctions-refresh 三行 `ACTIVE`、generation=1；`patents-cache-refresh` 按设计**没有行** |
| 不可逆 | generation 只前进；撤销只能把 `state` 置 `DISABLED`，而那会让 platform budget authority 与 worker 不就绪、客户侧写入 503 |

历史：2026-10-01 由人工以 owner 身份执行 `install.sql`（记录在
`/global/_archive/platform-egress-policy-install-xin-20261001/`）。

## 2. 目标

gain-saas 接管三件事，**不重新实现策略数学**：

1. **期望值**：调用引擎的 platform technical-quote 端点取得每个 schedule 的
   `policy_revision`、`policy_artifact_sha256`、`execution_envelope_sha256`、`required_cap_per_run_microusd`。
2. **差异判断**：读取当前 fence 行，只有「值不同且 generation 匹配」才需要安装。
3. **安装与审计**：以 owner 连接调用 `install_platform_egress_policy_v2`，记录 from→to generation、
   artifact、cap、操作者与时间。

## 3. 设计

### 3.1 数据源

- 期望值：来自**引擎容器内的推导产物**（`R4_EGRESS_EXPECTED_FILE`，JSONL），与 2026-10-01
  安装时用的是同一支脚本（`_archive/platform-egress-policy-install-xin-20261001/egress-expected.cjs`）。
  为什么不直接调 technical-quote 端点：它要求 `scheduleRequestSha256`、固定 `workflowRunId` 等契约输入，
  只有引擎内部有；在外部拼这些输入等于复制引擎的计价逻辑。
- 当前状态：复用 `OpsDatabase` 的 owner 池（`OPS_OWNER_DATABASE_URL`），只执行两条语句：
  - `SELECT schedule_id, generation, state, policy_artifact_sha256, execution_envelope_sha256, required_cap_microusd FROM platform_egress_schedule_fence`
  - `SELECT * FROM install_platform_egress_policy_v2($1,$2,$3,$4,$5)`

### 3.2 触发方式

**不做自动轮询。** 只在两个时机执行：

1. **干跑**（默认）：只计算差异并打印，不写库。验收、排障、切换前都用它。
2. **显式安装**：由运营台的一个按钮或一条命令触发，参数必须包含 `expectedGeneration`，
   与库中当前值不一致时拒绝（乐观并发）。

理由：generation 只前进，误推进的代价是「策略与报价脱节」，而它会静默影响平台自动化的准入。

### 3.3 不变量（实现时必须逐条断言）

- 只处理 `PLATFORM_SCHEDULES` 中的四个 id；`patents-cache-refresh` **永不安装**
- 当前行缺失时不得凭空创建（必须走首次安装的显式流程）
- `state` 必须是 `ACTIVE`；`DISABLED` 行只能由人决定后重开，不由本服务自动翻转
- `expectedGeneration` 必须等于库中 `generation`
- 报价返回的 `policy_revision` 必须与引擎当前策略资产摘要一致，否则拒绝安装

### 3.4 审计

每次真实安装追加一条记录（gain-saas 自有库 `r4_egress_install_audit`）：
`schedule_id, from_generation, to_generation, policy_artifact_sha256, execution_envelope_sha256,
required_cap_microusd, operator, at, quote_policy_revision`。
干跑不写审计。

## 4. 验收

| 项 | 方法 |
| --- | --- |
| 干跑与库中现状一致 | 跑干跑，输出「无需安装」 |
| 差异识别正确 | 人为把某行 `required_cap_microusd` 改小（在 disposable 库），干跑必须报差异 |
| 乐观并发 | 传入错误的 `expectedGeneration` 必须被拒绝 |
| 真实安装 | 在 disposable 库上推进一次 generation，readiness 仍 ready，审计有记录 |
| 不碰 patents | 干跑与安装都不出现 `patents-cache-refresh` |

## 5. 风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 写引擎库的权限面 | gain-saas 从「签发方」变成「写引擎库的运维方」 | 只允许上述两条语句；owner 连接不暴露给业务代码 |
| generation 误推进 | 策略与报价脱节会静默影响准入 | 干跑优先 + expectedGeneration 强校验 + 审计 |
| 安装窗口 | 安装期间 platform worker 可能短暂不就绪 | 只在窗口内执行；失败即停并报告 |
| 回退代价高 | 回退是把 state 置 DISABLED，会关闭客户写入 | 安装前先干跑；保留 quote 输入，可复算 |

## 6. 回退

- 未安装前：无操作。
- 已推进 generation：**不能回退 generation**。若策略确实错了，只能
  把 `state` 置 `DISABLED` 并接受 platform worker 不就绪，然后修复报价后重新安装。
  该操作必须由人在窗口内执行，不自动化。

## 7. 实施步骤（TDD）

1. 契约夹具：把 `install_platform_egress_policy_v2` 的参数与报价字段抄成类型与测试
2. 干跑实现：读库 + 算差异，纯读，先写测试（fake owner 池）
3. 安装实现：带 expectedGeneration 的调用与审计写入
4. 集成测试：disposable PG 上跑一次真实安装（使用现有 disposable 夹具）
5. 运营台按钮 + 干跑输出（P3d-UI，可后置）

## 8. 不在范围

- 重新实现策略数学（期望值一律来自引擎报价）
- 平台 schedule 的恢复运行（仍需 L4-G23）
- egress 策略的**内容**变更（那是报价与契约的事）

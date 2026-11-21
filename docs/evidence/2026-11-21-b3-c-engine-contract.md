# B3-C 完整市场候选合同与薄消费者证据

> 日期：2026-11-21。层次：源码合同及隔离合成消费者；不是页面、部署、真实模型或客户验收。

## 固定来源和生成

| 工件 | 绑定 |
|---|---|
| SaaS 施工基线 | 594c7e4d8528c6c540c5640984426a0701672c1e |
| 引擎目标源码 | 31da69d57565b8d17a2c9bb033411be8a006ef5a |
| 完整原产物 SHA-256 | ca317fba1b4da919647177ea3049aa68f95ecd2c55649b8f20138978abf2474c |
| 原产物规模 | 996843 字节；158 paths、89 schemas |
| 实际生成 pin SHA-256 | 7f50d42aa5948b44202a4db2b2af831d25d807bc646f9fe844399f14955dc15b |
| pin 规模 | 996844 字节；原生成器 JSON 序列化后带末尾换行 |

已核完整原产物来自目标提交中跟踪的 code-first 文件。仅由本任务自有127.0.0.1随机端口静态 fixture 提供完整文件，显式 ENGINE_OPENAPI_URL 调用原 gen:engine；只响应一次 GET /api/docs-json 后关闭，不加载引擎应用、真实 env 或旧3000/现役4020服务。生成 spec 和类型没有手工编辑。新 pin 对旧锁的真实摘要拒绝已先观察，再更新同 PR 锁文件，raw 与 pin 摘要不混用。

## 薄消费与完整兼容

- 注册九条普通成员接口：五条候选读取/反馈与四条生成操作。仅 execute 标记预算 Grant，路由等待240000ms；其余沿原默认，不修改 handler、签发器、配额或环境。
- execute 报价同时携带原 generationId 与实际 forward body，不抽取合法字段洗掉对象中的 actor、attemptId 等未知字段。非法输入沿严格 quote 拒绝；原 handler 对空值的既有处理不被改成可签成功。只有原 quote→适用配额→签发→执行链可出预算授权。
- 八条非执行接口没有预算 quote/issue；普通身份 JWT 与执行预算分开计。真实配额组件仍对新 purpose 检查累计花费，不把它改标 discovery.run 或新增余额账。
- 完整 JSON 逐项重算与冻结审查同为14处：四路径、五 DTO、一个 quote oneOf、三个响应枚举及 tags。旧153个其它路径和83个其它 schema 相同，原11个 quote 分支逐字保留。现84条旧路由值和顺序保持，严格覆盖为93/93/0，无新豁免。
- 全生成类型 AST 审核旧路径154项无变化/删除，旧174个 operation 仅 quote 扩展；旧84个 schema 仅 quote 响应枚举扩展。未筛选全类型及 OAS diff 随同头工程包交原技术、产品复验，不只审九路径。

同现 CI 固定 action 对应的 oasdiff 1.32.1，以完整旧 pin 对完整新 pin 实际 breaking 退出1，仅有 response-property-enum-value-added 三项：quote 200 的 data/operation、data/purpose、data/subjectType。准确组件指针为 WorkspaceTechnicalBudgetQuoteResponseDto 的对应 enum。此非绿色结果；须本 SaaS PR 的独立兼容审批，不复用后端标签授权。engine-contract-breaking-approved 会跳过整个 breaking 步骤，因此审批必须限定已固定的完整差分；新错误不得借标签放行。

在九目标操作完整的独有 scratch clone 中，删除原 query-plan execute 和移除 manufacturer-network/v2 分别被同版全合同门报额外 ERR，未修改真实 pin。错9620产物、只摘九路径、额外换行污染均被原 verify-pin 拒绝；生成类型重新生成逐字一致，单独篡改 scratch 类型后的比较真实失败。

## 合成验证及结果边界

原已有五 B1 合同的正例保留。新合同/路由先真实 RED，最小实现后相关回归通过；完整实际次数、命令、原日志、最终 head/tree 与终态随工程签出包提供，不能据本文存在推断所有 CI 已绿。

测试经过真实普通租户守卫、中间件、BFF handler、EngineHttp、EngineBudgetGrantService 和 WorkspaceBudgetPolicyService。仅会话/持久层、fetch 引擎和密码签发边界为受控合成；不生成可供现役运行接受的业务 Grant，不读真实私钥。预算签发尝试与成功出具分开计，受控 signer 拒绝可有一次尝试但零出具；不是实际签名验证或真钱结算。

覆盖各非执行动作、原体报价/旧授权循环、非法/错归属/过期/花费拒绝、普通身份与预算分离、200/202及七 phase、NOT_ANALYZED/合法空/候选内容、双国/null/冲突/反证/负面结论、四反馈和409原 key/修订、历史分页/nextCursor、初始 revision1引用与较晚current、未知原操作恢复及无隐式重签/重发。新测试的 DTO 消费另以 server 声明的 TypeScript 实际编译，不把 Vitest 转译当类型校验。

现事件消费者源码与施工基线相同，本切片不增加候选事件投影。候选仍由引擎持久/ACK及 HTTP 权威读，OAS/types 不校验事件 payload；事件兼容仅人工核相关源，不冒机器事件门通过。

原C01–C12只验完整合同和薄消费者，不替代 B3-U 的页面、语言/主题/终端/键盘矩阵或运行采用。没有业务库查询/迁移、模型/vendor、真实 Grant、发送、服务启停、部署或新 AI。回退撤回本逻辑 PR 的 SaaS 消费与 pin，不改引擎已存候选/历史/费用，不以回退重新购买未知操作。


## 整仓 typecheck 原样基线红门

完整本地构建、全部单测、server 类型检查及上述合同门已有实际结果；整仓 `pnpm typecheck` 仍返回失败，不能称整仓验证全绿。诊断位于未修改的页面和第三方插件消费处：寻源任务页空值检查、工作台未用变量及两个 locale 声明缺失。

相关文件、web tsconfig、锁文件与施工基线逐字相同。同一依赖和同一原页面源，通过独有私有编译配置显式解析到基线旧 engine-client 类型，真实复现相同错误位置和消息，未修改实际源码、配置或生成物。该反证不是另一个完整基线部署或页面验收，也不把红门改成通过。

这些文件不在本切片允许范围内，须由原技术/主管定向裁定基线工程边界或精确补范围；本 PR 不擅改 web、加声明、宽松配置或豁免检查。最终工程包保留失败命令和同头消费者通过证据，原样供独立复验与审合决定。

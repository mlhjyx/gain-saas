---
date: 2026-11-20
title: Bind optional manufacturer evidence execution through the normal acquisition request
---

- 起因：厂家关系证明新增的执行版本需要同时进入正常报价和实际请求；复用同一任务 attempt 时必须拒绝改变 plan／证明版本，避免误读为原操作重放。
- 改动：增加默认关闭的部署能力，只有显式 v1/v2 标记才启用；BFF 与任务执行共用规范化字段，服务器 revision 类型和前端受控选项直接来自生成的 ExecuteQueryPlanDto。任务新增 nullable 请求摘要及前向约束，保留无标记旧请求和 NULL 历史行；两个正常 Web API 使用同一请求构造函数，不新增用户可见技术选项。固定引擎合同升级独立交付。
- 测试：当前 BFF/config 10份118项单元测试及服务器类型检查／构建通过，涵盖双版本报价／转发、原 attempt、双向版本漂移、并发赢家重放不重复报价；专用生成合同类型检查 RED→GREEN。Web 请求构造函数3项纯函数检查、静态构建及术语／日期检查通过；3项不是实际浏览器UI验收。当前相关四文件覆盖率 statements81.1%/lines82.86%/functions86.2%/branches67.64%，不声称全维80%以上。
- 未做：未应用迁移或做真实PostgreSQL竞争测试、未运行产品quote/Grant/Backend往返、未部署或触达，不宣称真实客户或30/100目标达成。额外全Web类型检查的现有诊断与独立SDK合同差异分别保留于任务验证证据，未通过ignore/label/CI改动隐藏；必需build及Playwright门仍各按实际证据验收。

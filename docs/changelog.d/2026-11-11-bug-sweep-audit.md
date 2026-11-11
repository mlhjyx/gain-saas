---
date: 2026-11-11
title: Full-system bug sweep from a structured audit
---

- 起因:全系统复盘审计(views 逐类扫描 + server 逐路由/逐服务核对),共 15 个真实运行期缺陷。
- 改动:web 5 个 i18n 键类 bug(六步残留/制裁单复数/traceStep/reopen 键);server 10 个——事件消费毒事件隔离(头阻塞根治)、run link 跨租户 upsert 校验、BFF 非 JSON 响应按字节透传、ops 渠道参数 UUID 防穿越、幂等键作用域加路径参数、消费防重入、坏编码 400、workspace UUID 404、switch 参数 400。
- 测试:server 633 单测全绿(3 个测试文件的 mock 随实现同步更新);web typecheck+build;CI=1 全量 e2e 38 条全绿。审计同时核验了 grant quote 映射(9 条 grant 路由逐字段对引擎 parseRequest)、fillParams 编码、DI 导入、ops SQL 参数化、路由权限位、轮询定时器与并发扇出——均无问题。
- 未做:S10(ops 度量/批次列表的无限量 findMany)为性能隐患非缺陷,留待性能专项。

---
date: 2026-11-12
title: 生产依赖安全修复：multer / Vue SSR / deepmerge-ts / glob / tinypool
---

- 起因：2026-11-12 审计 L-3/依赖监控首次运行发现生产依赖 14 个漏洞（2 critical / 4 high），其中 multer 2.4.0、@vue/server-renderer 3.5.41、deepmerge-ts 7.1.5、glob 10.4.5、tinypool 2.1.0 均有可用修复版本。
- 改动：pnpm overrides 钉住 `multer 2.5.0`、`deepmerge-ts 8.0.0`、`glob 10.5.0`、`tinypool 2.1.2`；Vue catalog 从 3.5.41 升到 3.5.42（同时带动 @vue/server-renderer）。
- 测试：`pnpm audit --prod --registry=https://registry.npmjs.org/`、`pnpm build`、`pnpm test`、`pnpm typecheck`；CI 的 build/test/contract 与 e2e。
- 未做：不处理 dev-only 告警；不以 major 框架升级（NestJS/Vue 大版本）替代补丁。

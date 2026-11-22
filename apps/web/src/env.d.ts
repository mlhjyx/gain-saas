/// <reference types="vite/client" />

/** 构建时由 apps/web/vite.config.ts 注入：产品版本（仓库根 package.json）。 */
declare const __APP_VERSION__: string;
/** 构建时由 apps/web/vite.config.ts 注入：提交短 SHA；非 git 环境为空串。 */
declare const __APP_COMMIT__: string;

/**
 * Vben 的 vxe-table 插件按子路径加载语言包，包本身未随版本提供 .d.ts。
 * 这里只补模块声明，不改变运行行为（P0 基线修复）。
 */
declare module 'vxe-pc-ui/lib/language/en-US';
declare module 'vxe-pc-ui/lib/language/zh-CN';

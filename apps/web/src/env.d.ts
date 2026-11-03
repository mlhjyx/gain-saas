/// <reference types="vite/client" />

/** 构建时由 apps/web/vite.config.ts 注入：产品版本（仓库根 package.json）。 */
declare const __APP_VERSION__: string;
/** 构建时由 apps/web/vite.config.ts 注入：提交短 SHA；非 git 环境为空串。 */
declare const __APP_COMMIT__: string;

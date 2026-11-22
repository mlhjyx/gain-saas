import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from '@vben/vite-config';

/** 产品版本取仓库根 package.json（apps/web 的 5.8.0 是 vben 模板版本，不是产品版本）。 */
function readAppVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(process.cwd(), '../../package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 构建时提交短 SHA；用于在侧栏区分同一版本号下的不同发布。 */
function readCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: resolve(process.cwd(), '../..'),
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

/** 开发/预发共用的 /api 代理：转发到本机 gain-saas-web（systemd 的 BFF）。 */
const PREVIEW_PROXY = {
  '/api': {
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
    target: 'http://127.0.0.1:4020/api',
    ws: true,
  },
};

export default defineConfig(async () => {
  return {
    application: {},
    vite: {
      define: {
        __APP_VERSION__: JSON.stringify(readAppVersion()),
        __APP_COMMIT__: JSON.stringify(readCommit()),
      },
      // workspace 包构建产物是 CommonJS：Vite dev 对符号链接包不预打包、
      // 直接以原生 ESM 加载会丢命名导出（"does not provide an export named 'navLabel'"）。
      // include 进 optimizeDeps 让 esbuild 做 CJS→ESM 转换；仅影响 dev server。
      optimizeDeps: {
        include: ['@gain-saas/shared'],
      },
      server: {
        proxy: PREVIEW_PROXY,
      },
      // 预发（5666）= 生产构建 + 同一套 /api 代理：冷加载是单个打包产物，
      // 不再有 dev 的数百个模块请求；行为与线上一致（含 tailwind 类名）。
      preview: {
        host: true,
        proxy: PREVIEW_PROXY,
      },
    },
  };
});

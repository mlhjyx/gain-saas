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
        proxy: {
          '/api': {
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/api/, ''),
            // 开发预发代理：转发到本机 gain-saas-web（systemd 的 BFF，真实登录与数据）。
            // 仓库内没有 @vben/backend-mock 包，原 nitro mock 目标(5320)不会被启用。
            target: 'http://127.0.0.1:4020/api',
            ws: true,
          },
        },
      },
    },
  };
});

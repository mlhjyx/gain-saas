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
      server: {
        proxy: {
          '/api': {
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/api/, ''),
            // mock代理目标地址
            target: 'http://localhost:5320/api',
            ws: true,
          },
        },
      },
    },
  };
});

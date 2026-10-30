/**
 * 开发期 .env 加载:从 cwd 向上最多 5 级找 .env(开发时 cwd=apps/server,文件在仓库根)。
 * 生产(systemd)用 EnvironmentFile 直接注入环境变量,本模块不生效、不覆盖已有值。
 */
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

let dir = process.cwd();
for (let depth = 0; depth < 5; depth += 1) {
  const candidate = join(dir, '.env');
  if (existsSync(candidate)) {
    dotenvConfig({ path: candidate });
    break;
  }
  const parent = dirname(dir);
  if (parent === dir) break;
  dir = parent;
}

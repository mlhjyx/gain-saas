import '../shared/load-env.js';
/**
 * 开发/演示用嵌入式 PostgreSQL(SD:不碰引擎容器、无需 root/docker)。
 * - 数据目录 apps/server/data/pg(.gitignore 已忽略 data/),持久化;
 * - 127.0.0.1:5433,用户 gain_saas,库 gain_saas —— 与 deploy/compose.postgres.yml 的生产形态同构;
 * - 首次运行自动 initdb + 建库;之后常驻,直到进程被停。
 * 生产部署仍用 compose 容器;本脚本只为让"先跑起来"不依赖任何系统权限。
 */
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import EmbeddedPostgres from 'embedded-postgres';

const DATA_DIR = join(process.cwd(), 'data', 'pg');
const PORT = 5433;
const USER = 'gain_saas';
const PASSWORD = 'dev';
const DATABASE = 'gain_saas';

async function main(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const firstRun = !existsSync(join(DATA_DIR, 'PG_VERSION'));
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
    onError: (err: Error) => {
      console.error('[dev-postgres] 异常:', err.message);
    },
  });

  if (firstRun) {
    console.log('[dev-postgres] 首次运行:初始化数据库目录…');
    await pg.initialise();
  }
  await pg.start();
  console.log(`[dev-postgres] PostgreSQL 已启动:127.0.0.1:${PORT}(数据目录 ${DATA_DIR})`);

  if (firstRun) {
    await pg.createDatabase(DATABASE);
    console.log(`[dev-postgres] 已创建数据库 ${DATABASE}`);
  } else {
    // 目录已存在但库可能未建(异常中断过的场景)
    const client = new Client({ connectionString: `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${USER}` });
    await client.connect();
    const exists = await client.query<boolean>("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1)", [DATABASE]);
    await client.end();
    if (!exists.rows[0]?.exists) {
      await pg.createDatabase(DATABASE);
      console.log(`[dev-postgres] 补建数据库 ${DATABASE}`);
    }
  }

  console.log(`[dev-postgres] 就绪:postgresql://${USER}:***@127.0.0.1:${PORT}/${DATABASE}`);
  console.log('[dev-postgres] Ctrl+C 停止(数据保留在 data/pg)');
  // 常驻:数据库子进程随本进程生命周期
  await new Promise(() => undefined);
}

void main().catch((err) => {
  console.error('[dev-postgres] 启动失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});

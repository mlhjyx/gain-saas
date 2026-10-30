import '../shared/load-env.js';
/**
 * 存量回放准备(SD4 / PRD G4):把引擎 outbox_event 中出现过的工作空间登记进
 * SaaS workspace_registry,使 worker 能拉取这些 workspace 的存量事件。
 *
 * 运行:pnpm bootstrap:backfill(只读引擎库)。
 * 连接必须是能看到 outbox_event 的角色:引擎对 app_user 启用 RLS,只给 app_user
 * 会静默读到 0 行;用 OPS_BACKFILL_DATABASE_URL / ENGINE_DATABASE_URL 指向 owner
 * (或带 BYPASSRLS 的只读角色)。
 * 注意:消费还需要引擎侧 saas-event-consumer 角色映射(deploy/engine-integration.md)。
 */
import { Pool } from 'pg';
import { PrismaService } from '../shared/prisma.service.js';

async function main(): Promise<void> {
  const connectionString =
    process.env.OPS_BACKFILL_DATABASE_URL ??
    process.env.ENGINE_DATABASE_URL ??
    process.env.OPS_OWNER_DATABASE_URL ??
    '';
  if (!connectionString) {
    console.error('缺少引擎库连接串(OPS_BACKFILL_DATABASE_URL / ENGINE_DATABASE_URL / OPS_OWNER_DATABASE_URL),无法回填。');
    process.exit(1);
  }
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 });
  const prisma = new PrismaService();
  try {
    const { rows } = await pool.query<{ workspace_id: string; events: string; name: string | null }>(
      `SELECT e.workspace_id::text, count(*)::text AS events, w.name
       FROM outbox_event e
       LEFT JOIN workspace w ON w.id = e.workspace_id
       WHERE e.workspace_id IS NOT NULL
       GROUP BY e.workspace_id, w.name
       ORDER BY count(*) DESC`,
    );
    console.log(`引擎侧共 ${rows.length} 个有事件的工作空间`);
    if (rows.length === 0) {
      console.warn('可见 0 个:若引擎确有存量事件,该连接多半被 outbox_event 的 RLS 过滤(app_user 即如此),换 owner/BYPASSRLS 连接重跑。');
    }
    let created = 0;
    for (const row of rows) {
      // workspace_registry 对 workspace 有外键:历史工作空间在 SaaS 侧没有行,先建影子行(无成员,不进任何人的切换器)
      await prisma.workspace.upsert({
        where: { id: row.workspace_id },
        create: { id: row.workspace_id, name: row.name ?? `引擎存量工作空间 ${row.workspace_id.slice(0, 8)}` },
        update: {},
      });
      const existing = await prisma.workspaceRegistry.findUnique({ where: { workspaceId: row.workspace_id } });
      if (existing) {
        await prisma.workspaceRegistry.update({ where: { workspaceId: row.workspace_id }, data: { enabled: true } });
        console.log(`  已存在,重新启用:${row.workspace_id}(${row.events} 事件)`);
      } else {
        await prisma.workspaceRegistry.create({ data: { workspaceId: row.workspace_id } });
        created += 1;
        console.log(`  登记待消费:${row.workspace_id}(${row.events} 事件)`);
      }
    }
    console.log(`回填完成:新建 ${created},共 ${rows.length} 个 workspace 进入消费清单。`);
  } finally {
    await pool.end().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}

void main();

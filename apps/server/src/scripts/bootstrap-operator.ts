import '../shared/load-env.js';
/**
 * 创建/重置运营账号(SD9 独立登录域)。
 * 用法:
 *   pnpm --filter @gain-saas/server bootstrap:operator -- --email ops@gainos.local --password '...'
 *   或 OPS_BOOTSTRAP_EMAIL / OPS_BOOTSTRAP_PASSWORD。
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const email = (arg('email') ?? process.env.OPS_BOOTSTRAP_EMAIL ?? '').trim().toLowerCase();
  const password = arg('password') ?? process.env.OPS_BOOTSTRAP_PASSWORD ?? '';
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
    console.error('需要合法邮箱:--email 或 OPS_BOOTSTRAP_EMAIL');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('密码至少 10 位:--password 或 OPS_BOOTSTRAP_PASSWORD');
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    const passwordHash = await argon2.hash(password);
    const user = await prisma.opsUser.upsert({
      where: { email },
      create: { email, passwordHash, status: 'active' },
      update: { passwordHash, status: 'active' },
    });
    console.log(`运营账号已就绪:${user.email}(${user.id})`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();

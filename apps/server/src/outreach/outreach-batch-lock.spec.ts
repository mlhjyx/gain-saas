import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../shared/prisma.service.js';
import { PostgresAdvisoryBatchLock } from './outreach-batch-lock.js';

class FakeLockPrisma {
  lockFree = true;
  unlocked: string[] = [];

  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = strings.join('?');
    if (sql.includes('pg_try_advisory_lock')) {
      return [{ locked: this.lockFree }];
    }
    if (sql.includes('pg_advisory_unlock')) {
      this.unlocked.push(String(values[0]));
      return [{ pg_advisory_unlock: true }];
    }
    return [];
  }
}

describe('PostgresAdvisoryBatchLock（P4-04 批次互斥）', () => {
  it('拿到锁时执行回调并在 finally 释放', async () => {
    const prisma = new FakeLockPrisma();
    const lock = new PostgresAdvisoryBatchLock(prisma as unknown as PrismaService);
    const fn = vi.fn(async () => 'ok');
    const outcome = await lock.withLock('batch-1', fn);
    expect(outcome).toEqual({ acquired: true, result: 'ok' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(prisma.unlocked).toEqual(['batch-1']);
  });

  it('锁被占用时返回 acquired=false 且不执行回调', async () => {
    const prisma = new FakeLockPrisma();
    prisma.lockFree = false;
    const lock = new PostgresAdvisoryBatchLock(prisma as unknown as PrismaService);
    const fn = vi.fn(async () => 'never');
    const outcome = await lock.withLock('batch-1', fn);
    expect(outcome).toEqual({ acquired: false });
    expect(fn).not.toHaveBeenCalled();
    expect(prisma.unlocked).toEqual([]);
  });

  it('回调抛错时仍然释放锁', async () => {
    const prisma = new FakeLockPrisma();
    const lock = new PostgresAdvisoryBatchLock(prisma as unknown as PrismaService);
    await expect(
      lock.withLock('batch-1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(prisma.unlocked).toEqual(['batch-1']);
  });

  it('有 $transaction 时在单事务连接内走 pg_try_advisory_xact_lock 杜绝连接池锁泄漏', async () => {
    const queries: string[] = [];
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
            queries.push(strings.join('?'));
            return [{ locked: true }];
          }),
        }),
      ),
    };
    const lock = new PostgresAdvisoryBatchLock(prisma as unknown as PrismaService);
    const outcome = await lock.withLock('batch-tx', async () => 'done');
    expect(outcome).toEqual({ acquired: true, result: 'done' });
    expect(queries[0]).toContain('pg_try_advisory_xact_lock');
  });
});

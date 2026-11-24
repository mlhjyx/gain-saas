import { Injectable } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service.js';

export const OUTREACH_BATCH_LOCK = Symbol('OUTREACH_BATCH_LOCK');

export type BatchLockOutcome<T> = { acquired: true; result: T } | { acquired: false };

/**
 * 批次级互斥（P4-04）：多进程/多实例并发推进同一批次时的硬防线。
 * 发送器内部还有 inFlight（进程内）+ 台账唯一键（batch,draft,attempt），三层兜底。
 */
export interface OutreachBatchLock {
  withLock<T>(batchId: string, fn: () => Promise<T>): Promise<BatchLockOutcome<T>>;
}

@Injectable()
export class PostgresAdvisoryBatchLock implements OutreachBatchLock {
  constructor(private readonly prisma: PrismaService) {}

  async withLock<T>(batchId: string, fn: () => Promise<T>): Promise<BatchLockOutcome<T>> {
    // 生产 Prisma 连接池上，pg_try_advisory_lock / pg_advisory_unlock 在不同池连接上执行会泄漏锁；
    // 在 $transaction 内使用事务级 pg_try_advisory_xact_lock 绑定单连接，事务结束或断连自动释放。
    if (typeof (this.prisma as unknown as { $transaction?: unknown }).$transaction === 'function') {
      return this.prisma.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
            SELECT pg_try_advisory_xact_lock(hashtextextended(${batchId}, 0)) AS locked
          `;
          if (!rows[0]?.locked) return { acquired: false } as const;
          return { acquired: true, result: await fn() } as const;
        },
        { maxWait: 10_000, timeout: 120_000 },
      );
    }
    const rows = await this.prisma.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_lock(hashtextextended(${batchId}, 0)) AS locked
    `;
    if (!rows[0]?.locked) return { acquired: false };
    try {
      return { acquired: true, result: await fn() };
    } finally {
      await this.prisma
        .$queryRaw`SELECT pg_advisory_unlock(hashtextextended(${batchId}, 0))`
        .catch(() => undefined);
    }
  }
}

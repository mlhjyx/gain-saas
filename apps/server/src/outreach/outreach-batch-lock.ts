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

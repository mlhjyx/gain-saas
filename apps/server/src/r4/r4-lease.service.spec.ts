import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../shared/prisma.service.js';
import { R4LeaseService } from './r4-lease.service.js';

const NOW = 1_793_600_000_000;

function fixture(pendingBySchedule: Record<string, { count: number; oldest: Date | null }>) {
  const leaseFindMany = vi.fn().mockResolvedValue(
    ['acq-sweep', 'intent-sweep', 'sanctions-refresh', 'patents-cache-refresh'].map((scheduleId) => ({
      scheduleId,
      state: 'ACTIVE',
      lastSeenAt: new Date(NOW - 1_000),
      expiresAt: new Date(NOW + 10_000),
    })),
  );
  const requestFindMany = vi.fn(async ({ where }: { where: { scheduleId: string } }) => {
    const entry = pendingBySchedule[where.scheduleId];
    return entry?.oldest ? [{ createdAt: entry.oldest }] : [];
  });
  const requestCount = vi.fn(async ({ where }: { where: { scheduleId: string } }) =>
    pendingBySchedule[where.scheduleId]?.count ?? 0);
  const prisma = {
    r4ConsumerLease: { findMany: leaseFindMany },
    r4RevocationRequest: { findMany: requestFindMany, count: requestCount },
  } as unknown as PrismaService;
  return { service: new R4LeaseService(prisma), requestFindMany, requestCount };
}

describe('撤销积压事实（P9 起读逻辑请求）', () => {
  it('只把 PENDING/BLOCKED/STORED_STATE_CONFLICT 计入积压', async () => {
    const { service, requestFindMany, requestCount } = fixture({
      'acq-sweep': { count: 1, oldest: new Date(NOW - 5_000) },
    });
    const facts = await service.read(NOW);
    expect(facts).not.toBeNull();
    expect(requestCount).toHaveBeenCalledWith({
      where: { scheduleId: 'acq-sweep', state: { in: ['PENDING', 'BLOCKED', 'STORED_STATE_CONFLICT'] } },
    });
    expect(requestFindMany).toHaveBeenCalledWith({
      where: { scheduleId: 'acq-sweep', state: { in: ['PENDING', 'BLOCKED', 'STORED_STATE_CONFLICT'] } },
      orderBy: { createdAt: 'asc' },
      take: 1,
      select: { createdAt: true },
    });
    const acq = facts!.find((fact) => fact.scheduleId === 'acq-sweep');
    expect(acq).toMatchObject({ undeliveredCount: 1, oldestUndeliveredCreatedAt: NOW - 5_000 });
    const other = facts!.find((fact) => fact.scheduleId === 'intent-sweep');
    expect(other).toMatchObject({ undeliveredCount: 0, oldestUndeliveredCreatedAt: null });
  });
});

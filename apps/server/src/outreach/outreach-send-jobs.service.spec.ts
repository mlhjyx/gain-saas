import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../shared/prisma.service.js';
import { OutreachSendJobsService, sendJobKey } from './outreach-send-jobs.service.js';

interface Row {
  [key: string]: unknown;
}

const NOW = new Date('2026-11-11T09:00:00Z');

class FakeJobsPrisma {
  jobs: Row[] = [];
  seq = 0;

  private id(): string {
    return `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`;
  }

  readonly outreachSendJob = {
    findMany: async ({ where, take }: { where: Row; take?: number }) => {
      let rows = this.jobs.filter((row) => matches(row, where));
      rows = rows
        .slice()
        .sort(
          (a, b) =>
            (a.nextAttemptAt as Date).getTime() - (b.nextAttemptAt as Date).getTime() ||
            (a.id as string).localeCompare(b.id as string),
        );
      if (take) rows = rows.slice(0, take);
      return rows.map((row) => ({ ...row }));
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = this.jobs.filter((row) => matches(row, where));
      for (const row of rows) {
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === 'object' && 'increment' in (value as Row)) {
            row[key] = ((row[key] as number) ?? 0) + (value as { increment: number }).increment;
          } else {
            row[key] = value;
          }
        }
      }
      return { count: rows.length };
    },
  };

  readonly $transaction = async (
    operations: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>),
  ) => {
    if (typeof operations === 'function') return operations(this);
    return Promise.all(operations);
  };
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      const obj = condition as Record<string, unknown>;
      if ('in' in obj) return (obj.in as unknown[]).includes(row[key]);
      if ('lte' in obj) return (row[key] as Date).getTime() <= (obj.lte as Date).getTime();
      return true;
    }
    return row[key] === condition;
  });
}

function seed(prisma: FakeJobsPrisma, overrides: Row = {}): Row {
  const row = {
    id: prisma.jobs.length + 1 + '',
    workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    batchId: '11111111-1111-4111-8111-111111111111',
    draftId: '33333333-3333-4333-8333-333333333333',
    state: 'PENDING',
    nextAttemptAt: new Date(NOW.getTime() - 60_000),
    attempts: 0,
    claimToken: null,
    lastError: null,
    idempotencyKey: sendJobKey('b', `d${prisma.jobs.length + 1}`),
    ...overrides,
  };
  prisma.jobs.push(row);
  return row;
}

function service(prisma: FakeJobsPrisma) {
  return new OutreachSendJobsService(prisma as unknown as PrismaService);
}

describe('OutreachSendJobsService（P4-04 job 队列）', () => {
  it('claim：只认领到期 PENDING，置 CLAIMED 并递增 attempts；第二次认领为空', async () => {
    const prisma = new FakeJobsPrisma();
    const due = seed(prisma);
    seed(prisma, { nextAttemptAt: new Date(NOW.getTime() + 60_000) });
    const instance = service(prisma);

    const first = await instance.claim(10, NOW);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: due.id, attempts: 1 });
    expect(prisma.jobs[0].state).toBe('CLAIMED');
    expect(prisma.jobs[0].claimToken).toBeTruthy();

    const second = await instance.claim(10, NOW);
    expect(second).toHaveLength(0);
  });

  it('reschedule：回到 PENDING 且更新下次时间与错误；markDone 终态清理 token', async () => {
    const prisma = new FakeJobsPrisma();
    const row = seed(prisma);
    const instance = service(prisma);
    const [claimed] = await instance.claim(1, NOW);

    const nextAt = new Date(NOW.getTime() + 120_000);
    await instance.reschedule([claimed.id], nextAt, 'DEFERRED');
    expect(prisma.jobs[0]).toMatchObject({
      state: 'PENDING',
      claimToken: null,
      lastError: 'DEFERRED',
    });
    expect((prisma.jobs[0].nextAttemptAt as Date).getTime()).toBe(nextAt.getTime());

    const [again] = await instance.claim(1, new Date(nextAt.getTime() + 1));
    expect(again.attempts).toBe(2);
    await instance.markDone([again.id]);
    expect(prisma.jobs[0]).toMatchObject({ state: 'DONE', claimToken: null, lastError: null });
    expect(row.state).toBe('DONE');
  });

  it('markFailed/markCancelled 只作用于 CLAIMED 状态', async () => {
    const prisma = new FakeJobsPrisma();
    seed(prisma, { state: 'PENDING' });
    const instance = service(prisma);
    await instance.markFailed(['1'], 'x');
    await instance.markCancelled(['1']);
    expect(prisma.jobs[0].state).toBe('PENDING'); // 未被误改

    const [claimed] = await instance.claim(1, NOW);
    await instance.markFailed([claimed.id], 'SMTP_DELIVERY_FAILED');
    expect(prisma.jobs[0]).toMatchObject({ state: 'FAILED', lastError: 'SMTP_DELIVERY_FAILED' });
  });
});

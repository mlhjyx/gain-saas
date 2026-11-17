import { describe, expect, it, vi } from 'vitest';
import { AuthThrottleService, type ThrottlePolicy } from './auth-throttle.service.js';

const POLICY: ThrottlePolicy = { limit: 2, windowMs: 60_000 };

function serviceWith(row: { key: string; count: number; resetAt: Date; updatedAt: Date } | null) {
  const store = { row };
  const authThrottle = {
    findUnique: vi.fn(async () => store.row),
    deleteMany: vi.fn(async (args: { where?: { resetAt?: { lte?: Date } } }) => {
      if (!store.row) return { count: 0 };
      if (args.where?.resetAt?.lte && store.row.resetAt > args.where.resetAt.lte) return { count: 0 };
      store.row = null;
      return { count: 1 };
    }),
    upsert: vi.fn(async (args: { create: typeof store.row; update: { count: { increment: number } } }) => {
      store.row = store.row
        ? { ...store.row, count: store.row.count + args.update.count.increment, updatedAt: new Date() }
        : args.create;
      return store.row;
    }),
  };
  const prisma = {
    authThrottle,
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ authThrottle })),
  };
  return { service: new AuthThrottleService(prisma as never), store, authThrottle };
}

describe('AuthThrottleService', () => {
  it('allows a first attempt with no stored row', async () => {
    const { service } = serviceWith(null);
    await expect(service.check('k', POLICY)).resolves.toBeUndefined();
  });

  it('blocks once the limit is reached', async () => {
    const { service } = serviceWith({ key: 'k', count: 2, resetAt: new Date(Date.now() + 60_000), updatedAt: new Date() });
    await expect(service.check('k', POLICY)).rejects.toMatchObject({ status: 429 });
  });

  it('clears an expired window before checking', async () => {
    const { service, store } = serviceWith({ key: 'k', count: 2, resetAt: new Date(Date.now() - 1), updatedAt: new Date() });
    await expect(service.check('k', POLICY)).resolves.toBeUndefined();
    expect(store.row).toBeNull();
  });

  it('creates then increments the counter', async () => {
    const { service, store } = serviceWith(null);
    await service.hit('k', POLICY);
    expect(store.row?.count).toBe(1);
    await service.hit('k', POLICY);
    expect(store.row?.count).toBe(2);
  });

  it('clears the counter on success', async () => {
    const { service, store } = serviceWith({ key: 'k', count: 2, resetAt: new Date(Date.now() + 60_000), updatedAt: new Date() });
    await service.success('k');
    expect(store.row).toBeNull();
  });
});

describe('AuthThrottleService.consume', () => {
  function consumeService(rows: Array<{ count: number; retry_after_seconds: number }>) {
    const prisma = { $queryRaw: vi.fn(async () => rows) };
    return new AuthThrottleService(prisma as never);
  }

  it('allows a request within the limit', async () => {
    const service = consumeService([{ count: 2, retry_after_seconds: 60 }]);
    await expect(service.consume('k', POLICY)).resolves.toBeUndefined();
  });

  it('rejects atomically once the limit is exceeded and reports retry seconds', async () => {
    const service = consumeService([{ count: 3, retry_after_seconds: 42 }]);
    await expect(service.consume('k', POLICY)).rejects.toMatchObject({
      status: 429,
      response: { error: { code: 'RATE_LIMITED', retryAfterSeconds: expect.any(Number) } },
    });
  });
});

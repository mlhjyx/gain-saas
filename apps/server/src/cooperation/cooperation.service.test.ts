import { describe, expect, it, vi } from 'vitest';
import { CooperationIntentService } from './cooperation.service.js';

function makeService() {
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
    cooperationIntent: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const row = { id: '11111111-1111-4111-8111-111111111111', createdAt: new Date('2026-11-17T10:00:00Z'), ...args.data };
        rows.push(row);
        return { id: row.id, createdAt: row.createdAt };
      }),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      groupBy: vi.fn(async () => [
        { status: 'NEW', _count: { _all: 2 } },
        { status: 'CONTACTED', _count: { _all: 1 } },
        { status: 'CLOSED', _count: { _all: 0 } },
      ]),
      findUnique: vi.fn(async () => ({ id: '11111111-1111-4111-8111-111111111111' })),
      update: vi.fn(async () => ({ id: '11111111-1111-4111-8111-111111111111' })),
    },
  };
  const throttle = {
    check: vi.fn(async () => undefined),
    hit: vi.fn(async () => undefined),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const config = { SESSION_SECRET: 'test-secret-test-secret-test-secret' };
  const service = new CooperationIntentService(prisma as never, throttle as never, audit as never, config as never);
  return { service, prisma, throttle, audit };
}

const VALID = {
  name: '张三',
  email: 'Zhang@Example.com',
  company: '上海某某贸易',
  contact: 'https://example.com',
  industry: '工业制造',
  region: '欧洲',
  message: '希望代理贵司产品。',
};

describe('CooperationIntentService.submit', () => {
  it('stores a cleaned intent and hashes the client ip', async () => {
    const { service, prisma, throttle } = makeService();
    const result = await service.submit(VALID, { ip: '203.0.113.9', userAgent: 'Mozilla/5.0' });

    expect(result.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(prisma.cooperationIntent.create).toHaveBeenCalledOnce();
    const data = prisma.cooperationIntent.create.mock.calls[0]![0].data;
    expect(data.name).toBe('张三');
    expect(data.email).toBe('zhang@example.com');
    expect(data.source).toBe('website');
    expect(data.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.ipHash).not.toContain('203.0.113.9');
    expect(throttle.check).toHaveBeenCalledTimes(3);
    expect(throttle.hit).toHaveBeenCalledTimes(3);
    // 同一 IP 的短窗与日窗必须是不同计数键，否则两次 hit 会把短窗配额翻倍消耗。
    const keys = throttle.hit.mock.calls.map((call) => call[0] as string);
    expect(new Set(keys).size).toBe(3);
    expect(keys.filter((key) => key.startsWith('coop-intent:ip:'))).toHaveLength(2);
  });

  it('rejects XSS payloads before writing', async () => {
    const { service, prisma } = makeService();
    await expect(
      service.submit({ ...VALID, name: '<script>alert(1)</script>' }, { ip: '203.0.113.9' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.cooperationIntent.create).not.toHaveBeenCalled();
  });

  it('rejects malformed emails and missing names', async () => {
    const { service, prisma } = makeService();
    await expect(service.submit({ ...VALID, email: 'nope' }, { ip: '1.1.1.1' })).rejects.toMatchObject({ status: 400 });
    await expect(service.submit({ ...VALID, name: '' }, { ip: '1.1.1.1' })).rejects.toMatchObject({ status: 400 });
    expect(prisma.cooperationIntent.create).not.toHaveBeenCalled();
  });

  it('propagates 429 from the throttle', async () => {
    const { service, throttle, prisma } = makeService();
    throttle.check.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }));
    await expect(service.submit(VALID, { ip: '1.1.1.1' })).rejects.toMatchObject({ status: 429 });
    expect(prisma.cooperationIntent.create).not.toHaveBeenCalled();
  });

  it('rejects a non-object body', async () => {
    const { service } = makeService();
    await expect(service.submit('hello', { ip: '1.1.1.1' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('CooperationIntentService.list', () => {
  it('returns rows with per-status counts', async () => {
    const { service } = makeService();
    const result = await service.list({ limit: 50, offset: 0 });
    expect(result.counts).toEqual({ NEW: 2, CONTACTED: 1, CLOSED: 0 });
    expect(result.total).toBe(0);
  });

  it('rejects an unknown status filter', async () => {
    const { service } = makeService();
    await expect(service.list({ status: 'HACKED' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('CooperationIntentService.update', () => {
  it('marks an intent handled and audits the operator', async () => {
    const { service, prisma, audit } = makeService();
    await service.update({ id: '11111111-1111-4111-8111-111111111111', status: 'CONTACTED', note: '已电话联系', actorId: 'ops-1' });
    const data = prisma.cooperationIntent.update.mock.calls[0]![0].data;
    expect(data.status).toBe('CONTACTED');
    expect(data.handledAt).toBeInstanceOf(Date);
    expect(data.handledBy).toBe('ops-1');
    expect(data.note).toBe('已电话联系');
    expect(audit.record).toHaveBeenCalledOnce();
  });

  it('sanitizes the note and rejects injected markup', async () => {
    const { service, prisma } = makeService();
    await expect(
      service.update({ id: '11111111-1111-4111-8111-111111111111', note: '<img src=x onerror=alert(1)>', actorId: 'ops-1' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.cooperationIntent.update).not.toHaveBeenCalled();
  });
});

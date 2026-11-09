import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../shared/audit.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import { OutreachReconciliationService } from './outreach-reconciliation.service.js';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BATCH = '11111111-1111-4111-8111-111111111111';
const DRAFT_1 = '33333333-3333-4333-8333-333333333333';
const DRAFT_2 = '44444444-4444-4444-8444-444444444444';
const tenant: OutreachTenant = { userId: 'user-a', workspaceId: WS, role: 'admin' };
const DAY = new Date('2026-11-10T00:00:00Z');
const IN_DAY = new Date('2026-11-10T09:00:00Z');

interface Row {
  [key: string]: unknown;
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      const obj = condition as Record<string, unknown>;
      if ('gte' in obj) return (row[key] as Date).getTime() >= (obj.gte as Date).getTime();
      if ('lt' in obj) return (row[key] as Date).getTime() < (obj.lt as Date).getTime();
      if ('in' in obj) return (obj.in as unknown[]).includes(row[key]);
      return true;
    }
    return row[key] === condition;
  });
}

class FakeReconcilePrisma {
  sends: Row[] = [];
  drafts: Row[] = [];

  readonly outreachSend = {
    findMany: async ({ where }: { where: Row }) =>
      this.sends.filter((row) => matches(row, where)),
  };
  readonly outreachDraft = {
    findMany: async ({ where }: { where: Row }) =>
      this.drafts.filter((row) => matches(row, where)),
  };
}

function build() {
  const prisma = new FakeReconcilePrisma();
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  return {
    prisma,
    service: new OutreachReconciliationService(
      prisma as unknown as PrismaService,
      audit,
    ),
  };
}

function send(overrides: Row = {}): Row {
  return {
    id: `send-${Math.random().toString(16).slice(2)}`,
    workspaceId: WS,
    batchId: BATCH,
    draftId: DRAFT_1,
    status: 'SENT',
    messageId: 'm-1@example.test',
    authorizationId: '99999999-9999-4999-8999-999999999999',
    authorizationUse: 1,
    error: null,
    createdAt: IN_DAY,
    ...overrides,
  };
}

describe('OutreachReconciliationService（P4-14 日对账）', () => {
  it('干净的一天：台账与草稿、授权消费、消息 id 全部勾稽 → ok=true', async () => {
    const { prisma, service } = build();
    prisma.sends = [send()];
    prisma.drafts = [{ id: DRAFT_1, batchId: BATCH, status: 'SENT' }];
    const result = await service.reconcile(tenant, DAY);
    expect(result).toMatchObject({ ok: true, day: '2026-11-10' });
    expect(result.counts.sends).toBe(1);
    expect(result.limitations.length).toBeGreaterThan(0);
  });

  it('缺口：缺 messageId / 缺授权消费 / 台账 SENT 但草稿未 SENT / 草稿缺失', async () => {
    const { prisma, service } = build();
    prisma.sends = [
      send({ id: 's1', messageId: null }),
      send({ id: 's2', authorizationId: null, authorizationUse: null, draftId: DRAFT_2 }),
      send({ id: 's3', draftId: '55555555-5555-4555-8555-555555555555' }),
    ];
    prisma.drafts = [
      { id: DRAFT_1, batchId: BATCH, status: 'APPROVED' },
      { id: DRAFT_2, batchId: BATCH, status: 'SENT' },
    ];
    const result = await service.reconcile(tenant, DAY);
    const codes = result.discrepancies.map((row) => row.code);
    expect(codes).toContain('SENT_WITHOUT_MESSAGE_ID');
    expect(codes).toContain('SEND_WITHOUT_AUTHORIZATION_USE');
    expect(codes).toContain('LEDGER_SENT_DRAFT_NOT_SENT');
    expect(codes).toContain('DRAFT_MISSING');
    expect(result.ok).toBe(false);
  });

  it('缺口：草稿 SENT 但没有任何 SENT 台账（跨日重试仍算有账）/ 同日重复 SENT', async () => {
    const { prisma, service } = build();
    prisma.sends = [send({ id: 's1' }), send({ id: 's2' })];
    prisma.drafts = [
      { id: DRAFT_1, batchId: BATCH, status: 'SENT' },
      { id: DRAFT_2, batchId: BATCH, status: 'SENT' },
    ];
    const result = await service.reconcile(tenant, DAY);
    const codes = result.discrepancies.map((row) => row.code);
    expect(codes).toContain('DUPLICATE_SENT_ATTEMPTS');
    expect(codes).toContain('DRAFT_SENT_WITHOUT_LEDGER');
  });

  it('缺口：SKIPPED 无原因', async () => {
    const { prisma, service } = build();
    prisma.sends = [
      send({ status: 'SKIPPED', messageId: null, authorizationId: null, authorizationUse: null, error: null }),
    ];
    prisma.drafts = [{ id: DRAFT_1, batchId: BATCH, status: 'SKIPPED' }];
    const result = await service.reconcile(tenant, DAY);
    expect(result.discrepancies.map((row) => row.code)).toContain('SKIPPED_WITHOUT_REASON');
  });

  it('按 workspace 隔离且只统计当天；date 参数校验', async () => {
    const { prisma, service } = build();
    prisma.sends = [send({ workspaceId: WS_B }), send({ createdAt: new Date('2026-11-09T09:00:00Z') })];
    prisma.drafts = [];
    const result = await service.reconcile(tenant, DAY);
    expect(result.counts.sends).toBe(0);
    expect(result.ok).toBe(true);

    expect(() => service.parseDay('2026/11/10')).toThrow();
    expect(() => service.parseDay('')).toThrow();
    expect(service.parseDay(undefined)).toBeUndefined();
    expect(service.parseDay('2026-11-10')!.toISOString()).toBe('2026-11-10T00:00:00.000Z');
  });
});

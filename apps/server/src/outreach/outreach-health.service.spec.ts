import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { AuditService } from '../shared/audit.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import { OutreachHealthService } from './outreach-health.service.js';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-11-11T09:00:00Z');
const tenant: OutreachTenant = { userId: 'user-a', workspaceId: WS, role: 'admin' };

interface Row {
  [key: string]: unknown;
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      const obj = condition as Record<string, unknown>;
      if ('gte' in obj) return (row[key] as Date).getTime() >= (obj.gte as Date).getTime();
      if ('in' in obj) return (obj.in as unknown[]).includes(row[key]);
      return true;
    }
    return row[key] === condition;
  });
}

class FakeHealthPrisma {
  mailboxes: Row[] = [];
  sends: Row[] = [];
  replies: Row[] = [];
  breakers: Row[] = [];
  events: Row[] = [];
  seq = 0;

  private id(): string {
    return `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`;
  }

  readonly outreachMailbox = {
    findMany: async ({ where }: { where: Row }) =>
      this.mailboxes.filter((row) => row.workspaceId === where.workspaceId),
  };
  readonly outreachSend = {
    count: async ({ where }: { where: Row }) =>
      this.sends.filter((row) => matches(row, where)).length,
  };
  readonly outreachReply = {
    count: async ({ where }: { where: Row }) =>
      this.replies.filter((row) => matches(row, where)).length,
  };
  readonly outreachBreaker = {
    findUnique: async ({
      where,
    }: {
      where: { workspaceId_scope_scopeRef: { workspaceId: string; scope: string; scopeRef: string } };
    }) => {
      const key = where.workspaceId_scope_scopeRef;
      return (
        this.breakers.find(
          (row) =>
            row.workspaceId === key.workspaceId &&
            row.scope === key.scope &&
            row.scopeRef === key.scopeRef,
        ) ?? null
      );
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { workspaceId_scope_scopeRef: { workspaceId: string; scope: string; scopeRef: string } };
      create: Row;
      update: Row;
    }) => {
      const key = where.workspaceId_scope_scopeRef;
      const existing = this.breakers.find(
        (row) =>
          row.workspaceId === key.workspaceId &&
          row.scope === key.scope &&
          row.scopeRef === key.scopeRef,
      );
      if (existing) {
        Object.assign(existing, update);
        return { ...existing };
      }
      const row = { updatedAt: new Date(), ...create };
      this.breakers.push(row);
      return { ...row };
    },
    update: async ({
      where,
      data,
    }: {
      where: { workspaceId_scope_scopeRef: { workspaceId: string; scope: string; scopeRef: string } };
      data: Row;
    }) => {
      const key = where.workspaceId_scope_scopeRef;
      const row = this.breakers.find(
        (candidate) =>
          candidate.workspaceId === key.workspaceId &&
          candidate.scope === key.scope &&
          candidate.scopeRef === key.scopeRef,
      )!;
      Object.assign(row, data);
      return { ...row };
    },
    findMany: async ({ where }: { where: Row }) =>
      this.breakers.filter((row) => row.workspaceId === where.workspaceId),
  };
  readonly outreachHealthEvent = {
    create: async ({ data }: { data: Row }) => {
      const row = { id: this.id(), detectedAt: new Date(), ...data };
      this.events.push(row);
      return { ...row };
    },
    findMany: async ({ where }: { where: Row }) =>
      this.events
        .filter((row) => row.workspaceId === where.workspaceId)
        .slice(-50)
        .reverse(),
  };
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    OUTREACH_SMTP_FROM_ADDRESS: 'outreach@example.test',
    OUTREACH_BOUNCE_WINDOW_DAYS: 7,
    OUTREACH_BOUNCE_MIN_SAMPLE: 20,
    OUTREACH_BOUNCE_RATE_HALT: 0.05,
    OUTREACH_DOMAIN_BOUNCE_HALT_RATE: 0.1,
    OUTREACH_COMPLAINT_MIN_SAMPLE: 100,
    OUTREACH_COMPLAINT_RATE_HALT: 0.003,
    OUTREACH_HALF_OPEN_BATCH_LIMIT: 10,
    ...overrides,
  } as AppConfig;
}

function build(prisma = new FakeHealthPrisma(), overrides: Partial<AppConfig> = {}) {
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  return new OutreachHealthService(
    prisma as unknown as PrismaService,
    audit,
    config(overrides),
  );
}

function errorCode(error: unknown): string {
  return (error as { response?: { error?: { code?: string } } }).response?.error?.code ?? '';
}

function seedSends(prisma: FakeHealthPrisma, count: number, overrides: Row = {}) {
  for (let index = 0; index < count; index += 1) {
    prisma.sends.push({
      workspaceId: WS,
      status: 'SENT',
      mailboxAddress: 'outreach@example.test',
      recipientEmail: `k${index}@ziel.de`,
      sentAt: new Date(NOW.getTime() - 86_400_000),
      ...overrides,
    });
  }
}

describe('OutreachHealthService（P4-08 熔断持久化与恢复）', () => {
  it('信箱硬拒率 ≥5%（样本 ≥20）→ 开 mailbox 熔断并留 PAUSE 事件；重复评估不重复开闸', async () => {
    const prisma = new FakeHealthPrisma();
    prisma.mailboxes.push({ workspaceId: WS, address: 'outreach@example.test' });
    seedSends(prisma, 100);
    for (let index = 0; index < 6; index += 1) {
      prisma.sends.push({
        workspaceId: WS,
        status: 'FAILED',
        bounceType: 'HARD',
        mailboxAddress: 'outreach@example.test',
        recipientEmail: `bad${index}@ziel.de`,
        createdAt: new Date(NOW.getTime() - 3_600_000),
      });
    }
    const instance = build(prisma);

    expect(await instance.evaluateWorkspace(WS, NOW)).toEqual({ opened: 1 });
    const breaker = prisma.breakers.find((row) => row.scope === 'mailbox')!;
    expect(breaker).toMatchObject({
      scopeRef: 'outreach@example.test',
      state: 'OPEN',
      reason: 'HARD_BOUNCE_RATE',
    });
    expect(prisma.events.filter((row) => row.action === 'PAUSE')).toHaveLength(1);

    expect(await instance.evaluateWorkspace(WS, NOW)).toEqual({ opened: 0 });
    expect(prisma.events.filter((row) => row.action === 'PAUSE')).toHaveLength(1);
  });

  it('投诉率 ≥0.3%（样本 ≥100）→ 开 domain 熔断（COMPLAINT_RATE）', async () => {
    const prisma = new FakeHealthPrisma();
    prisma.mailboxes.push({ workspaceId: WS, address: 'outreach@example.test' });
    seedSends(prisma, 1_000);
    for (let index = 0; index < 4; index += 1) {
      prisma.replies.push({
        workspaceId: WS,
        kind: 'COMPLAINT',
        receivedAt: new Date(NOW.getTime() - 3_600_000),
      });
    }
    const instance = build(prisma);
    expect(await instance.evaluateWorkspace(WS, NOW)).toEqual({ opened: 1 });
    expect(prisma.breakers[0]).toMatchObject({
      scope: 'domain',
      scopeRef: 'example.test',
      reason: 'COMPLAINT_RATE',
    });
  });

  it('assertBatchAllowed：OPEN 整批拒绝；HALF_OPEN 返回小批上限；无记录放行', async () => {
    const prisma = new FakeHealthPrisma();
    const instance = build(prisma);
    await expect(
      instance.assertBatchAllowed(tenant, { mailboxAddress: 'outreach@example.test' }),
    ).resolves.toEqual({});

    prisma.breakers.push({
      workspaceId: WS,
      scope: 'mailbox',
      scopeRef: 'outreach@example.test',
      state: 'OPEN',
      reason: 'HARD_BOUNCE_RATE',
    });
    await expect(
      instance.assertBatchAllowed(tenant, { mailboxAddress: 'outreach@example.test' }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'OUTREACH_MAILBOX_PAUSED');

    prisma.breakers[0].state = 'HALF_OPEN';
    expect(
      await instance.assertBatchAllowed(tenant, { mailboxAddress: 'outreach@example.test' }),
    ).toEqual({ maxSend: 10 });

    prisma.breakers.push({
      workspaceId: WS,
      scope: 'domain',
      scopeRef: 'example.test',
      state: 'OPEN',
      reason: 'BOUNCE_RATE',
    });
    await expect(
      instance.assertBatchAllowed(tenant, {
        mailboxAddress: 'outreach@example.test',
        domain: 'example.test',
      }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'OUTREACH_DOMAIN_PAUSED');
  });

  it('恢复两步：OPEN→HALF_OPEN（必须根因）→CLOSED（必须复核说明），状态机之外拒绝', async () => {
    const prisma = new FakeHealthPrisma();
    prisma.breakers.push({
      workspaceId: WS,
      scope: 'mailbox',
      scopeRef: 'outreach@example.test',
      state: 'OPEN',
      reason: 'HARD_BOUNCE_RATE',
    });
    const instance = build(prisma);

    await expect(
      instance.recover(tenant, 'mailbox', 'outreach@example.test', ''),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');

    const halfOpen = await instance.recover(tenant, 'mailbox', 'outreach@example.test', '名单已清理');
    expect(halfOpen.state).toBe('HALF_OPEN');
    expect(prisma.events.some((row) => row.action === 'RECOVER')).toBe(true);

    await expect(
      instance.recover(tenant, 'mailbox', 'outreach@example.test', '再次恢复'),
    ).rejects.toSatisfy((error) => errorCode(error) === 'OUTREACH_BREAKER_NOT_OPEN');

    const closed = await instance.close(tenant, 'mailbox', 'outreach@example.test', '小批 10 封无退信');
    expect(closed.state).toBe('CLOSED');
    expect(prisma.events.some((row) => row.action === 'CLOSE')).toBe(true);

    await expect(
      instance.close(tenant, 'mailbox', 'outreach@example.test', '再次关闭'),
    ).rejects.toSatisfy((error) => errorCode(error) === 'OUTREACH_BREAKER_NOT_HALF_OPEN');
    await expect(
      instance.recover(tenant, 'nope', 'x', 'y'),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');
  });

  it('panel 返回熔断器与最近事件', async () => {
    const prisma = new FakeHealthPrisma();
    prisma.breakers.push({ workspaceId: WS, scope: 'domain', scopeRef: 'example.test', state: 'OPEN' });
    prisma.events.push({ workspaceId: WS, action: 'PAUSE', metric: 'BOUNCE_RATE' });
    const panel = await build(prisma).panel(tenant);
    expect(panel.breakers).toHaveLength(1);
    expect(panel.events).toHaveLength(1);
  });
});

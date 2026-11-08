import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { AppConfig } from '../config/configuration.js';
import type { AuditService } from '../shared/audit.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import { OutreachMailboxService } from './outreach-mailbox.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenant: OutreachTenant = { userId: 'user-a', workspaceId: WS, role: 'admin' };

interface Row {
  [key: string]: unknown;
}

class FakeMailboxPrisma {
  domains: Row[] = [];
  mailboxes: Row[] = [];
  counters: Row[] = [];
  domainCounters: Row[] = [];
  seq = 0;

  private id(): string {
    return `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`;
  }

  readonly outreachDomain = {
    upsert: async ({
      where,
      create,
    }: {
      where: { workspaceId_domain: { workspaceId: string; domain: string } };
      create: Row;
      update: Row;
    }) => {
      const { workspaceId, domain } = where.workspaceId_domain;
      const existing = this.domains.find(
        (row) => row.workspaceId === workspaceId && row.domain === domain,
      );
      if (existing) return { ...existing };
      const row = { id: this.id(), createdAt: new Date(), ...create };
      this.domains.push(row);
      return { ...row };
    },
  };

  readonly outreachMailbox = {
    findUnique: async ({
      where,
    }: {
      where: { workspaceId_address: { workspaceId: string; address: string } };
    }) => {
      const { workspaceId, address } = where.workspaceId_address;
      return (
        this.mailboxes.find(
          (row) => row.workspaceId === workspaceId && row.address === address,
        ) ?? null
      );
    },
    findFirst: async ({ where }: { where: Row }) =>
      this.mailboxes.find(
        (row) =>
          (!where.id || row.id === where.id) &&
          (!where.workspaceId || row.workspaceId === where.workspaceId),
      ) ?? null,
    findMany: async ({ where }: { where: Row }) =>
      this.mailboxes.filter((row) => row.workspaceId === where.workspaceId),
    create: async ({ data }: { data: Row }) => {
      if (
        this.mailboxes.some(
          (row) => row.workspaceId === data.workspaceId && row.address === data.address,
        )
      ) {
        throw new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      const row = { id: this.id(), createdAt: new Date(), lastSendAt: null, ...data };
      this.mailboxes.push(row);
      return { ...row };
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = this.mailboxes.find((candidate) => candidate.id === where.id)!;
      Object.assign(row, data);
      return { ...row };
    },
  };

  readonly outreachMailboxCounter = {
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { mailboxId_day: { mailboxId: string; day: Date } };
      create: Row;
      update: Row;
    }) => {
      const { mailboxId, day } = where.mailboxId_day;
      const existing = this.counters.find(
        (row) => row.mailboxId === mailboxId && (row.day as Date).getTime() === day.getTime(),
      );
      if (existing) {
        for (const [key, value] of Object.entries(update)) {
          if (value && typeof value === 'object' && 'increment' in (value as Row)) {
            existing[key] = ((existing[key] as number) ?? 0) + (value as { increment: number }).increment;
          }
        }
        return { ...existing };
      }
      const row = { sent: 0, hardBounces: 0, complaints: 0, ...create };
      this.counters.push(row);
      return { ...row };
    },
    findUnique: async ({
      where,
    }: {
      where: { mailboxId_day: { mailboxId: string; day: Date } };
    }) => {
      const { mailboxId, day } = where.mailboxId_day;
      return (
        this.counters.find(
          (row) => row.mailboxId === mailboxId && (row.day as Date).getTime() === day.getTime(),
        ) ?? null
      );
    },
    aggregate: async ({
      where,
    }: {
      where: { mailboxId: string; day: { gte: Date } };
      _sum: { sent: boolean };
    }) => {
      const rows = this.counters.filter(
        (row) =>
          row.mailboxId === where.mailboxId &&
          (row.day as Date).getTime() >= where.day.gte.getTime(),
      );
      return { _sum: { sent: rows.reduce((sum, row) => sum + ((row.sent as number) ?? 0), 0) } };
    },
  };

  readonly outreachDomainCounter = {
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: {
        domainId_hour_recipientDomain: {
          domainId: string;
          hour: Date;
          recipientDomain: string;
        };
      };
      create: Row;
      update: Row;
    }) => {
      const { domainId, hour, recipientDomain } = where.domainId_hour_recipientDomain;
      const existing = this.domainCounters.find(
        (row) =>
          row.domainId === domainId &&
          (row.hour as Date).getTime() === hour.getTime() &&
          row.recipientDomain === recipientDomain,
      );
      if (existing) {
        existing.sent = ((existing.sent as number) ?? 0) + 1;
        return { ...existing };
      }
      const row = { sent: 0, ...create };
      this.domainCounters.push(row);
      return { ...row };
    },
  };

  readonly $transaction = async (
    operations: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>),
  ) => {
    if (typeof operations === 'function') return operations(this);
    return Promise.all(operations);
  };
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    OUTREACH_SMTP_FROM_ADDRESS: 'outreach@example.test',
    OUTREACH_MAILBOX_DAILY_CAP: 30,
    OUTREACH_MAILBOX_WEEKLY_CAP: 120,
    ...overrides,
  } as AppConfig;
}

function service(prisma: FakeMailboxPrisma, overrides: Partial<AppConfig> = {}) {
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  return new OutreachMailboxService(
    prisma as unknown as PrismaService,
    audit,
    config(overrides),
  );
}

function errorCode(error: unknown): string {
  return (error as { response?: { error?: { code?: string } } }).response?.error?.code ?? '';
}

const NOW = new Date('2026-11-11T09:00:00Z');

describe('OutreachMailboxService（P4-02 发件资产与配额）', () => {
  it('默认信箱懒创建：MATURE + env 上限，重复调用幂等', async () => {
    const prisma = new FakeMailboxPrisma();
    const instance = service(prisma);
    const first = await instance.ensureDefaultMailbox(WS, 'Outreach@Example.test');
    expect(first).toMatchObject({
      address: 'outreach@example.test',
      warmupStage: 'MATURE',
      dailyCap: 30,
      weeklyCap: 120,
      state: 'ACTIVE',
    });
    expect(prisma.domains).toHaveLength(1);
    expect(prisma.domains[0].domain).toBe('example.test');
    const second = await instance.ensureDefaultMailbox(WS, 'outreach@example.test');
    expect(second!.id).toBe(first!.id);
    expect(prisma.mailboxes).toHaveLength(1);
  });

  it('未配置发件地址时返回 null（单信箱降级模式保持可用）', async () => {
    const prisma = new FakeMailboxPrisma();
    expect(await service(prisma).ensureDefaultMailbox(WS, undefined)).toBeNull();
    expect(prisma.mailboxes).toHaveLength(0);
  });

  it('usage 汇总今日与滚动 7 天计数', async () => {
    const prisma = new FakeMailboxPrisma();
    const instance = service(prisma);
    const mailbox = (await instance.ensureDefaultMailbox(WS, 'outreach@example.test'))!;
    prisma.counters.push(
      { mailboxId: mailbox.id, day: new Date('2026-11-11T00:00:00Z'), sent: 5 },
      { mailboxId: mailbox.id, day: new Date('2026-11-10T00:00:00Z'), sent: 7 },
      { mailboxId: mailbox.id, day: new Date('2026-11-04T00:00:00Z'), sent: 100 },
    );
    const usage = await instance.usage(mailbox.id, NOW);
    expect(usage.dailySent).toBe(5);
    expect(usage.weeklySent).toBe(12); // 11-10、11-11；11-04 在 7 天窗口外
  });

  it('recordSend 原子递增日计数与收件域小时计数，并更新 lastSendAt', async () => {
    const prisma = new FakeMailboxPrisma();
    const instance = service(prisma);
    const mailbox = (await instance.ensureDefaultMailbox(WS, 'outreach@example.test'))!;
    await instance.recordSend(mailbox, 'Buyer@Ziel.DE', NOW);
    await instance.recordSend(mailbox, 'other@ziel.de', NOW);
    expect(prisma.counters[0].sent).toBe(2);
    expect(prisma.domainCounters).toHaveLength(1);
    expect(prisma.domainCounters[0]).toMatchObject({ recipientDomain: 'ziel.de', sent: 2 });
    expect(prisma.mailboxes[0].lastSendAt).toEqual(NOW);
  });

  it('recordHardBounce 计入当日 hardBounces', async () => {
    const prisma = new FakeMailboxPrisma();
    const instance = service(prisma);
    const mailbox = (await instance.ensureDefaultMailbox(WS, 'outreach@example.test'))!;
    await instance.recordHardBounce(mailbox.id, NOW);
    expect(prisma.counters[0].hardBounces).toBe(1);
  });

  it('createMailbox：warmupStage=W2 采用该阶梯默认上限；重复地址拒绝', async () => {
    const prisma = new FakeMailboxPrisma();
    const instance = service(prisma);
    const created = await instance.createMailbox(tenant, {
      address: 'Marie@Example.com',
      displayName: 'Marie',
      warmupStage: 'W2',
    });
    expect(created).toMatchObject({
      address: 'marie@example.com',
      warmupStage: 'W2',
      dailyCap: 20,
      weeklyCap: 100,
    });
    await expect(
      instance.createMailbox(tenant, { address: 'marie@example.com', displayName: 'X' }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'OUTREACH_MAILBOX_DUPLICATE');
  });

  it('createMailbox 负向：非法地址/阶梯/超限 caps 拒绝', async () => {
    const prisma = new FakeMailboxPrisma();
    const instance = service(prisma);
    await expect(
      instance.createMailbox(tenant, { address: 'nope', displayName: 'X' }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');
    await expect(
      instance.createMailbox(tenant, {
        address: 'a@b.de',
        displayName: 'X',
        warmupStage: 'W9' as never,
      }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');
    await expect(
      instance.createMailbox(tenant, {
        address: 'a@b.de',
        displayName: 'X',
        dailyCap: 999,
      }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');
  });

  it('updateMailbox：只改显示名不动 caps；改 warmupStage 按新阶梯重置上限；地址不可变', async () => {
    const prisma = new FakeMailboxPrisma();
    const instance = service(prisma);
    const created = await instance.createMailbox(tenant, {
      address: 'marie@example.com',
      displayName: 'Marie',
      warmupStage: 'W1',
      dailyCap: 15,
      weeklyCap: 60,
    });
    const renamed = await instance.updateMailbox(tenant, created.id, { displayName: 'Marie L.' });
    expect(renamed.displayName).toBe('Marie L.');
    expect(renamed.dailyCap).toBe(15);
    expect(renamed.weeklyCap).toBe(60);

    const promoted = await instance.updateMailbox(tenant, created.id, { warmupStage: 'W3' });
    expect(promoted.dailyCap).toBe(30);
    expect(promoted.weeklyCap).toBe(150);

    const paused = await instance.updateMailbox(tenant, created.id, { state: 'PAUSED' });
    expect(paused.state).toBe('PAUSED');

    await expect(
      instance.updateMailbox(tenant, created.id, { address: 'other@example.com' }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');
  });

  it('summary 返回默认信箱 + 用量 + warmup 阶梯上限', async () => {
    const prisma = new FakeMailboxPrisma();
    const summary = await service(prisma).summary(tenant, NOW);
    expect(summary.mailbox).toMatchObject({ address: 'outreach@example.test' });
    expect(summary.usage).toEqual({ dailySent: 0, weeklySent: 0 });
    expect(summary.warmupCaps).toEqual({ daily: 40, weekly: 200 });
  });
});

import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../shared/prisma.service.js';
import { OutreachMailboxService } from './outreach-mailbox.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import { OutreachWarmupService } from './outreach-warmup.service.js';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenant: OutreachTenant = { userId: 'user-a', workspaceId: WS, role: 'admin' };
const NOW = new Date('2026-11-11T09:00:00Z');

interface Row {
  [key: string]: unknown;
}

class FakeWarmupPrisma {
  domains: Row[] = [];
  mailboxes: Row[] = [];
  seeds: Row[] = [];
  counters: Row[] = [];

  readonly outreachDomain = {
    findMany: async ({ where }: { where: Row }) =>
      this.domains.filter((row) => row.workspaceId === where.workspaceId),
  };
  readonly outreachMailbox = {
    findMany: async ({ where }: { where: Row }) =>
      this.mailboxes.filter(
        (row) => row.workspaceId === where.workspaceId && row.domainId === where.domainId,
      ),
  };
  readonly outreachSeedTest = {
    findFirst: async ({ where }: { where: Row }) =>
      this.seeds.find(
        (row) =>
          row.domainId === where.domainId &&
          (row.testedAt as Date).getTime() >= (where.testedAt as { gte: Date }).gte.getTime(),
      ) ?? null,
  };
  readonly outreachMailboxCounter = {
    findUnique: async ({ where }: { where: Row }) => null,
    aggregate: async () => ({ _sum: { sent: null } }),
  };
}

function build() {
  const prisma = new FakeWarmupPrisma();
  const mailboxService = new OutreachMailboxService(
    prisma as unknown as PrismaService,
    { record: async () => undefined } as never,
    { OUTREACH_SMTP_FROM_ADDRESS: undefined } as never,
  );
  const warmup = new OutreachWarmupService(
    prisma as unknown as PrismaService,
    mailboxService,
  );
  return { prisma, warmup };
}

describe('OutreachWarmupService（P4-12 周检查清单）', () => {
  it('种子新鲜且达标、信箱全部 ACTIVE → ok=true，并附用量余量', async () => {
    const { prisma, warmup } = build();
    prisma.domains = [{ id: 'd1', workspaceId: WS, domain: 'try-gainos.com', state: 'ACTIVE' }];
    prisma.mailboxes = [
      {
        id: 'm1',
        workspaceId: WS,
        domainId: 'd1',
        address: 'alex@try-gainos.com',
        state: 'ACTIVE',
        warmupStage: 'W2',
        dailyCap: 20,
        weeklyCap: 100,
      },
    ];
    prisma.seeds = [
      {
        domainId: 'd1',
        testedAt: new Date('2026-11-09T10:00:00Z'),
        provider: 'glockapps',
        inboxPct: 85,
        spamPct: 8,
        reportRef: 'ref-1',
      },
    ];
    const result = await warmup.checklist(tenant, NOW);
    expect(result.domains).toHaveLength(1);
    expect(result.domains[0].checks).toMatchObject({
      seedFresh: true,
      inboxOk: true,
      spamOk: true,
      mailboxesOk: true,
      ok: true,
    });
    expect(result.domains[0].mailboxes[0]).toMatchObject({
      warmupStage: 'W2',
      dailyRemaining: 20,
      weeklyRemaining: 100,
    });
  });

  it('种子超过 7 天视为不新鲜；Spam 超 10% 判失败', async () => {
    const { prisma, warmup } = build();
    prisma.domains = [{ id: 'd1', workspaceId: WS, domain: 'a.com', state: 'ACTIVE' }];
    prisma.mailboxes = [
      {
        id: 'm1',
        workspaceId: WS,
        domainId: 'd1',
        address: 'a@a.com',
        state: 'PAUSED',
        warmupStage: 'W1',
        dailyCap: 10,
        weeklyCap: 50,
      },
    ];
    prisma.seeds = [];
    const result = await warmup.checklist(tenant, NOW);
    expect(result.domains[0].checks).toMatchObject({
      seedFresh: false,
      mailboxesOk: false,
      ok: false,
    });

    prisma.seeds = [
      {
        domainId: 'd1',
        testedAt: new Date('2026-11-10T10:00:00Z'),
        provider: 'manual',
        inboxPct: 70,
        spamPct: 25,
        reportRef: 'ref',
      },
    ];
    const second = await warmup.checklist(tenant, NOW);
    expect(second.domains[0].checks).toMatchObject({
      seedFresh: true,
      inboxOk: false,
      spamOk: false,
      ok: false,
    });
  });
});

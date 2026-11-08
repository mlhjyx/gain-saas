import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../shared/audit.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import { OutreachSeedTestService } from './outreach-seed-test.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenant: OutreachTenant = { userId: 'user-a', workspaceId: WS, role: 'admin' };
const HASH = 'a'.repeat(64);

interface Row {
  [key: string]: unknown;
}

class FakeSeedPrisma {
  domains: Row[] = [];
  seedTests: Row[] = [];
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
      const row = { id: this.id(), ...create };
      this.domains.push(row);
      return { ...row };
    },
    findUnique: async ({
      where,
    }: {
      where: { workspaceId_domain: { workspaceId: string; domain: string } };
    }) => {
      const { workspaceId, domain } = where.workspaceId_domain;
      return (
        this.domains.find(
          (row) => row.workspaceId === workspaceId && row.domain === domain,
        ) ?? null
      );
    },
  };

  readonly outreachSeedTest = {
    create: async ({ data }: { data: Row }) => {
      const row = { id: this.id(), createdAt: new Date(), ...data };
      this.seedTests.push(row);
      return { ...row };
    },
    findMany: async ({ where }: { where: Row }) =>
      this.seedTests.filter(
        (row) =>
          row.workspaceId === where.workspaceId &&
          (!where.domainId || row.domainId === where.domainId),
      ),
  };
}

function service(prisma: FakeSeedPrisma) {
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  return new OutreachSeedTestService(prisma as unknown as PrismaService, audit);
}

function errorCode(error: unknown): string {
  return (error as { response?: { error?: { code?: string } } }).response?.error?.code ?? '';
}

describe('OutreachSeedTestService（P4-12 warmup/seed 周清单后端支撑）', () => {
  it('记录种子测试：百分比保留两位小数，域自动建档', async () => {
    const prisma = new FakeSeedPrisma();
    const row = await service(prisma).record(tenant, {
      domain: 'Try-GainOS.com',
      provider: 'glockapps',
      inboxPct: 85.555,
      spamPct: 9.4,
      missingPct: 5.04,
      reportRef: 's3://evidence/glockapps-2026-11-09.pdf',
      contentHash: HASH,
    });
    expect(row).toMatchObject({
      provider: 'glockapps',
      inboxPct: 85.56,
      spamPct: 9.4,
      missingPct: 5.04,
      contentHash: HASH,
    });
    expect(prisma.domains[0]).toMatchObject({ domain: 'try-gainos.com', workspaceId: WS });
  });

  it('负向：provider/百分比/reportRef/contentHash 校验', async () => {
    const prisma = new FakeSeedPrisma();
    const instance = service(prisma);
    const base = {
      domain: 'a.com',
      provider: 'glockapps',
      reportRef: 'ref',
      contentHash: HASH,
    };
    await expect(
      instance.record(tenant, { ...base, provider: 'unknown-vendor' }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');
    await expect(
      instance.record(tenant, { ...base, spamPct: 120 }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');
    await expect(
      instance.record(tenant, { ...base, contentHash: 'xyz' }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');
    await expect(
      instance.record(tenant, { ...base, reportRef: '' }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');
    expect(prisma.seedTests).toHaveLength(0);
  });

  it('按域过滤查询；未知域 404', async () => {
    const prisma = new FakeSeedPrisma();
    const instance = service(prisma);
    await instance.record(tenant, {
      domain: 'a.com',
      provider: 'inboxally',
      spamPct: 8,
      reportRef: 'r1',
      contentHash: HASH,
    });
    await instance.record(tenant, {
      domain: 'b.com',
      provider: 'manual',
      spamPct: 3,
      reportRef: 'r2',
      contentHash: HASH,
    });
    const filtered = await instance.list(tenant, 'a.com');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].provider).toBe('inboxally');
    await expect(instance.list(tenant, 'nope.com')).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_DOMAIN_NOT_FOUND',
    );
  });
});

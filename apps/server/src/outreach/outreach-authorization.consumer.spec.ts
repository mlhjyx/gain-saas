import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import {
  OutreachAuthorizationConsumer,
  hashOutreachAudience,
  hashOutreachDraftSet,
} from './outreach-authorization.consumer.js';
import type { OutreachTenant } from './outreach-consent.service.js';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BATCH = '11111111-1111-4111-8111-111111111111';
const BATCH_B = '11111111-1111-4111-8111-222222222222';
const CAMPAIGN = '77777777-7777-4777-8777-777777777777';
const CAMPAIGN_B = '77777777-7777-4777-8777-888888888888';
const AUTHZ = '99999999-9999-4999-8999-999999999999';
const DRAFT_1 = '33333333-3333-4333-8333-333333333333';
const DRAFT_2 = '44444444-4444-4444-8444-444444444444';
const CONTACT_1 = '55555555-5555-4555-8555-555555555555';
const CONTACT_2 = '66666666-6666-4666-8666-666666666666';
const CONTENT_HASH = 'a'.repeat(64);

const tenant: OutreachTenant = { userId: 'user-a', workspaceId: WS, role: 'admin' };

interface Row {
  [key: string]: unknown;
}

class FakeAuthzPrisma {
  authorizations: Row[] = [];
  sends: Row[] = [];

  readonly campaignExecutionAuthorization = {
    findFirst: async ({ where }: { where: Row }) =>
      this.authorizations.find(
        (row) =>
          (!where.id || row.id === where.id) &&
          (!where.workspaceId || row.workspaceId === where.workspaceId),
      ) ?? null,
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.authorizations.find((row) => row.id === where.id) ?? null,
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const row = this.authorizations.find(
        (candidate) =>
          candidate.id === where.id &&
          (!where.workspaceId || candidate.workspaceId === where.workspaceId) &&
          (!where.state || candidate.state === where.state) &&
          (where.uses as { lt: number } | undefined)?.lt !== undefined &&
          (candidate.uses as number) < (where.uses as { lt: number }).lt,
      );
      if (!row) return { count: 0 };
      const increment = (data.uses as { increment: number }).increment;
      row.uses = (row.uses as number) + increment;
      return { count: 1 };
    },
  };

  readonly outreachSend = {
    findMany: async ({ where }: { where: Row }) =>
      this.sends.filter(
        (row) =>
          row.batchId === where.batchId &&
          ((where.draftId as { in: string[] }).in.includes(row.draftId as string)) &&
          row.authorizationUse !== null &&
          row.authorizationUse !== undefined,
      ),
    findFirst: async ({ where }: { where: Row }) =>
      this.sends.find(
        (row) =>
          row.batchId === where.batchId &&
          row.draftId === where.draftId &&
          row.authorizationUse !== null &&
          row.authorizationUse !== undefined,
      ) ?? null,
  };
}

function drafts(contentHash = CONTENT_HASH) {
  return [
    { id: DRAFT_1, contactRef: CONTACT_1, countryCode: 'DE', contentHash },
    { id: DRAFT_2, contactRef: CONTACT_2, countryCode: 'US', contentHash },
  ];
}

function batch(overrides: Partial<Row> = {}): Row {
  return {
    id: BATCH,
    workspaceId: WS,
    campaignId: CAMPAIGN,
    authorizationId: AUTHZ,
    contentHash: CONTENT_HASH,
    ...overrides,
  };
}

function scopeFor(
  batchRow: Row,
  draftRows: ReadonlyArray<{ id: string; contactRef: string; contentHash: string }>,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    schemaVersion: 'campaign-authz/v2',
    campaignId: batchRow.campaignId,
    actions: [
      {
        type: 'outreach.email.send',
        batchId: batchRow.id,
        audience: {
          contactRefsHash: hashOutreachAudience(draftRows.map((draft) => draft.contactRef)),
          count: draftRows.length,
          sizeCap: 50,
        },
        template: {
          contentHash: batchRow.contentHash,
          draftSetHash: hashOutreachDraftSet(draftRows),
        },
        caps: {
          perMailboxDaily: 30,
          perMailboxWeekly: 120,
          perDomainHourly: 5,
          batchMax: 50,
        },
        schedule: {
          notBefore: new Date(Date.now() - 86_400_000).toISOString(),
          notAfter: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          windowLocal: '09:00-17:00',
          weekdays: [1, 2, 3, 4, 5],
          timezonePolicy: 'recipient_local',
        },
        budget: { currency: 'USD', capMicros: 5_000_000 },
        jurisdiction: {
          policyVersion: '2026-11-08.1',
          allowedCountries: ['DE', 'US', 'FR'],
          deniedCountries: [],
        },
        ...overrides,
      },
    ],
  };
}

function authorization(scope: unknown, overrides: Partial<Row> = {}): Row {
  return {
    id: AUTHZ,
    workspaceId: WS,
    campaignId: CAMPAIGN,
    revisionId: 'rev-1',
    planHash: 'p'.repeat(64),
    scope,
    state: 'ISSUED',
    maxUses: 2,
    uses: 0,
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

function consumer(prisma: FakeAuthzPrisma, overrides: Partial<AppConfig> = {}) {
  return new OutreachAuthorizationConsumer(prisma as unknown as PrismaService, {
    OUTREACH_COST_PER_EMAIL_MICROS: 37_000,
    ...overrides,
  } as AppConfig);
}

function errorCode(error: unknown): string {
  return (error as { response?: { error?: { code?: string } } }).response?.error?.code ?? '';
}

async function expectReject(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error) => errorCode(error) === code,
    `expected rejection ${code}, got ${code}`,
  );
}

describe('OutreachAuthorizationConsumer（执行授权 v2 只读消费）', () => {
  it('负向：批次未绑定授权 → CAMPAIGN_AUTHORIZATION_INVALID', async () => {
    const prisma = new FakeAuthzPrisma();
    await expectReject(
      consumer(prisma).authorizeBatch(tenant, batch({ authorizationId: null }), drafts(), 2),
      'CAMPAIGN_AUTHORIZATION_INVALID',
    );
  });

  it('负向：授权行不存在（跨租户/已删除）→ CAMPAIGN_AUTHORIZATION_INVALID', async () => {
    const prisma = new FakeAuthzPrisma();
    prisma.authorizations = [authorization(scopeFor(batch(), drafts()), { workspaceId: WS_B })];
    await expectReject(
      consumer(prisma).authorizeBatch(tenant, batch(), drafts(), 2),
      'CAMPAIGN_AUTHORIZATION_INVALID',
    );
  });

  it('负向：授权已被撤销 → CAMPAIGN_AUTHORIZATION_REVOKED', async () => {
    const prisma = new FakeAuthzPrisma();
    prisma.authorizations = [authorization(scopeFor(batch(), drafts()), { state: 'REVOKED' })];
    await expectReject(
      consumer(prisma).authorizeBatch(tenant, batch(), drafts(), 2),
      'CAMPAIGN_AUTHORIZATION_REVOKED',
    );
  });

  it('负向：授权已过期 → CAMPAIGN_AUTHORIZATION_EXPIRED', async () => {
    const prisma = new FakeAuthzPrisma();
    prisma.authorizations = [
      authorization(scopeFor(batch(), drafts()), { expiresAt: new Date(Date.now() - 1000) }),
    ];
    await expectReject(
      consumer(prisma).authorizeBatch(tenant, batch(), drafts(), 2),
      'CAMPAIGN_AUTHORIZATION_EXPIRED',
    );
  });

  it('负向：v1 scope（只有 discovery 动作）→ OUTREACH_AUTHORIZATION_SCOPE_MISMATCH', async () => {
    const prisma = new FakeAuthzPrisma();
    prisma.authorizations = [
      authorization({ actions: [{ type: 'discovery', icpIds: ['icp-1'] }], sizeCap: 100 }),
    ];
    await expectReject(
      consumer(prisma).authorizeBatch(tenant, batch(), drafts(), 2),
      'OUTREACH_AUTHORIZATION_SCOPE_MISMATCH',
    );
  });

  it('负向：授权给的是别的批次 → OUTREACH_AUTHORIZATION_SCOPE_MISMATCH', async () => {
    const prisma = new FakeAuthzPrisma();
    const other = batch({ id: BATCH_B });
    prisma.authorizations = [authorization(scopeFor(other, drafts()))];
    await expectReject(
      consumer(prisma).authorizeBatch(tenant, batch(), drafts(), 2),
      'OUTREACH_AUTHORIZATION_SCOPE_MISMATCH',
    );
  });

  it('负向：批次内容哈希与签发时不符 → OUTREACH_AUTHORIZATION_SCOPE_MISMATCH', async () => {
    const prisma = new FakeAuthzPrisma();
    prisma.authorizations = [authorization(scopeFor(batch(), drafts()))];
    const changed = drafts();
    changed[0] = { ...changed[0], contentHash: 'b'.repeat(64) };
    await expectReject(
      consumer(prisma).authorizeBatch(tenant, batch({ contentHash: 'c'.repeat(64) }), changed, 2),
      'OUTREACH_AUTHORIZATION_SCOPE_MISMATCH',
    );
  });

  it('负向：收件人集合被替换（audience 哈希不符）→ OUTREACH_AUTHORIZATION_SCOPE_MISMATCH', async () => {
    const prisma = new FakeAuthzPrisma();
    prisma.authorizations = [authorization(scopeFor(batch(), drafts()))];
    const replaced = [
      { ...drafts()[0], contactRef: '55555555-5555-4555-8555-aaaaaaaaaaaa' },
      drafts()[1],
    ];
    await expectReject(
      consumer(prisma).authorizeBatch(tenant, batch(), replaced, 2),
      'OUTREACH_AUTHORIZATION_SCOPE_MISMATCH',
    );
  });

  it('负向：收件人数与 audience.count 不符 → OUTREACH_AUTHORIZATION_SCOPE_MISMATCH', async () => {
    const prisma = new FakeAuthzPrisma();
    prisma.authorizations = [authorization(scopeFor(batch(), drafts()))];
    await expectReject(
      consumer(prisma).authorizeBatch(tenant, batch(), drafts().slice(0, 1), 1),
      'OUTREACH_AUTHORIZATION_SCOPE_MISMATCH',
    );
  });

  it('负向：计划窗口未开始 → OUTREACH_SCHEDULE_OUT_OF_WINDOW', async () => {
    const prisma = new FakeAuthzPrisma();
    prisma.authorizations = [
      authorization(
        scopeFor(batch(), drafts(), {
          schedule: {
            notBefore: '2099-01-01T00:00:00Z',
            notAfter: '2099-12-31T00:00:00Z',
          },
        }),
      ),
    ];
    await expectReject(
      consumer(prisma).authorizeBatch(tenant, batch(), drafts(), 2),
      'OUTREACH_SCHEDULE_OUT_OF_WINDOW',
    );
  });

  it('负向：计划窗口已结束 → OUTREACH_SCHEDULE_OUT_OF_WINDOW', async () => {
    const prisma = new FakeAuthzPrisma();
    prisma.authorizations = [
      authorization(
        scopeFor(batch(), drafts(), {
          schedule: { notBefore: '2020-01-01T00:00:00Z', notAfter: '2020-02-01T00:00:00Z' },
        }),
      ),
    ];
    await expectReject(
      consumer(prisma).authorizeBatch(tenant, batch(), drafts(), 2),
      'OUTREACH_SCHEDULE_OUT_OF_WINDOW',
    );
  });

  it('负向：预估成本超过授权预算 → OUTREACH_BUDGET_EXCEEDED', async () => {
    const prisma = new FakeAuthzPrisma();
    prisma.authorizations = [
      authorization(
        scopeFor(batch(), drafts(), { budget: { currency: 'USD', capMicros: 37_000 } }),
      ),
    ];
    // 2 封 × 37,000 µUSD = 74,000 > 37,000。
    await expectReject(
      consumer(prisma).authorizeBatch(tenant, batch(), drafts(), 2),
      'OUTREACH_BUDGET_EXCEEDED',
    );
  });

  it('负向：批次含授权拒绝的国家 → OUTREACH_AUTHORIZATION_SCOPE_MISMATCH', async () => {
    const prisma = new FakeAuthzPrisma();
    prisma.authorizations = [
      authorization(
        scopeFor(batch(), drafts(), {
          jurisdiction: { allowedCountries: ['US', 'FR'], deniedCountries: ['DE'] },
        }),
      ),
    ];
    await expectReject(
      consumer(prisma).authorizeBatch(tenant, batch(), drafts(), 2),
      'OUTREACH_AUTHORIZATION_SCOPE_MISMATCH',
    );
  });

  it('负向：待发数超过剩余 uses → CAMPAIGN_AUTHORIZATION_USES_EXHAUSTED', async () => {
    const prisma = new FakeAuthzPrisma();
    prisma.authorizations = [authorization(scopeFor(batch(), drafts()), { maxUses: 2, uses: 1 })];
    await expectReject(
      consumer(prisma).authorizeBatch(tenant, batch(), drafts(), 2),
      'CAMPAIGN_AUTHORIZATION_USES_EXHAUSTED',
    );
  });

  it('重试不重复消费：已消费过的草稿沿用首次序号', async () => {
    const prisma = new FakeAuthzPrisma();
    prisma.authorizations = [authorization(scopeFor(batch(), drafts()), { maxUses: 2, uses: 1 })];
    prisma.sends = [{ batchId: BATCH, draftId: DRAFT_1, authorizationUse: 1 }];
    const instance = consumer(prisma);
    const grant = await instance.authorizeBatch(tenant, batch(), drafts(), 1);
    expect(grant.remainingUses).toBe(1);
    expect(await instance.consumeForDraft(tenant, grant, DRAFT_1)).toBe(1);
    expect(prisma.authorizations[0].uses).toBe(1); // 未再次递增
  });

  it('正例：逐封消费 uses 1..n，消耗完后再发即拒绝', async () => {
    const prisma = new FakeAuthzPrisma();
    prisma.authorizations = [authorization(scopeFor(batch(), drafts()), { maxUses: 2, uses: 0 })];
    const instance = consumer(prisma);
    const grant = await instance.authorizeBatch(tenant, batch(), drafts(), 2);
    expect(grant).toMatchObject({ authorizationId: AUTHZ, remainingUses: 2, maxUses: 2 });

    expect(await instance.consumeForDraft(tenant, grant, DRAFT_1)).toBe(1);
    expect(await instance.consumeForDraft(tenant, grant, DRAFT_2)).toBe(2);
    expect(prisma.authorizations[0].uses).toBe(2);

    await expect(instance.consumeForDraft(tenant, grant, 'draft-3')).rejects.toSatisfy(
      (error) => errorCode(error) === 'CAMPAIGN_AUTHORIZATION_USES_EXHAUSTED',
    );
  });

  it('负向：批次 campaignId 与授权 campaignId 不符 → OUTREACH_AUTHORIZATION_SCOPE_MISMATCH', async () => {
    const prisma = new FakeAuthzPrisma();
    prisma.authorizations = [authorization(scopeFor(batch(), drafts()))];
    await expectReject(
      consumer(prisma).authorizeBatch(tenant, batch({ campaignId: CAMPAIGN_B }), drafts(), 2),
      'OUTREACH_AUTHORIZATION_SCOPE_MISMATCH',
    );
  });
});

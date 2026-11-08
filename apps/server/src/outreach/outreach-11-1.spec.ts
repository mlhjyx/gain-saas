import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { OutreachConsentService, type OutreachTenant } from './outreach-consent.service.js';
import { OutreachUnsubscribeService } from './outreach-unsubscribe.service.js';

const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONTACT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const EMAIL = 'buyer@example.com';

const tenantA: OutreachTenant = { userId: 'user-a', workspaceId: WS_A, role: 'admin' };
const tenantB: OutreachTenant = { userId: 'user-b', workspaceId: WS_B, role: 'admin' };

interface ConsentRow {
  id: string;
  workspaceId: string;
  contactRef: string;
  channel: string;
  status: 'OPT_IN' | 'OPT_OUT' | 'UNKNOWN';
  source: string;
  lawfulBasis: string;
  evidence?: unknown;
  createdAt: Date;
}

interface TokenRow {
  id: string;
  workspaceId: string;
  contactRef: string;
  recipientEmail?: string | null;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

class FakePrisma {
  readonly consents: ConsentRow[] = [];
  readonly tokens: TokenRow[] = [];

  readonly outreachConsent = {
    create: async ({ data }: { data: Omit<ConsentRow, 'id' | 'createdAt'> }) => {
      const row: ConsentRow = { id: randomUUID(), createdAt: new Date(), ...data };
      this.consents.push(row);
      return row;
    },
    findFirst: async ({
      where,
    }: {
      where: { workspaceId: string; contactRef: string; channel: string };
    }) =>
      [...this.consents]
        .filter(
          (row) =>
            row.workspaceId === where.workspaceId &&
            row.contactRef === where.contactRef &&
            row.channel === where.channel,
        )
        .at(-1) ?? null,
  };

  readonly outreachUnsubscribeToken = {
    create: async ({ data }: { data: Omit<TokenRow, 'id' | 'createdAt' | 'usedAt'> }) => {
      const row: TokenRow = {
        id: randomUUID(),
        createdAt: new Date(),
        usedAt: null,
        ...data,
      };
      this.tokens.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: { tokenHash: string } }) =>
      this.tokens.find((row) => row.tokenHash === where.tokenHash) ?? null,
  };

  readonly $transaction = async <T>(
    fn: (tx: {
      outreachUnsubscribeToken: {
        updateMany: (args: {
          where: { id: string; usedAt: null };
          data: { usedAt: Date };
        }) => Promise<{ count: number }>;
      };
      outreachConsent: {
        create: (args: {
          data: Omit<ConsentRow, 'id' | 'createdAt'>;
        }) => Promise<ConsentRow>;
      };
    }) => Promise<T>,
  ): Promise<T> =>
    fn({
      outreachUnsubscribeToken: {
        updateMany: async ({ where, data }) => {
          const row = this.tokens.find((item) => item.id === where.id);
          if (!row || row.usedAt) return { count: 0 };
          row.usedAt = data.usedAt;
          return { count: 1 };
        },
      },
      outreachConsent: {
        create: async ({ data }) => {
          const row: ConsentRow = { id: randomUUID(), createdAt: new Date(), ...data };
          this.consents.push(row);
          return row;
        },
      },
    });
}

function audit() {
  return { record: vi.fn(async () => undefined) } as never;
}

function dnc(result = new Map<string, string[]>()) {
  return { check: vi.fn(async () => result) } as never;
}

describe('outreach 11-1 compliance base', () => {
  it('negative 1: DE without consent is JURISDICTION_CONSENT_REQUIRED and never checks DNC', async () => {
    const checker = dnc();
    const service = new OutreachConsentService(new FakePrisma() as never, audit(), checker);
    const result = await service.eligibility(tenantA, {
      contactRef: CONTACT,
      countryCode: 'DE',
      email: EMAIL,
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('unreachable');
    expect(result.code).toBe('JURISDICTION_CONSENT_REQUIRED');
    expect((checker as unknown as { check: ReturnType<typeof vi.fn> }).check).not.toHaveBeenCalled();
  });

  it('DE with OPT_IN is allowed; US follows opt-out; other jurisdictions require review', async () => {
    const prisma = new FakePrisma();
    const service = new OutreachConsentService(prisma as never, audit(), dnc());
    await service.record(tenantA, {
      contactRef: CONTACT,
      status: 'OPT_IN',
      source: 'web_form',
      lawfulBasis: 'consent',
    });
    const de = await service.eligibility(tenantA, {
      contactRef: CONTACT,
      countryCode: 'DE',
      email: EMAIL,
    });
    expect(de.allowed).toBe(true);

    const us = await service.eligibility(tenantA, {
      contactRef: CONTACT,
      countryCode: 'US',
      email: EMAIL,
    });
    expect(us.allowed).toBe(true);

    const fr = await service.eligibility(tenantA, {
      contactRef: CONTACT,
      countryCode: 'FR',
      email: EMAIL,
    });
    expect(fr.allowed).toBe(false);
    if (!fr.allowed) expect(fr.code).toBe('JURISDICTION_REVIEW_REQUIRED');
  });

  it('negative 2: OPT_OUT blocks every later send regardless of jurisdiction', async () => {
    const prisma = new FakePrisma();
    const service = new OutreachConsentService(prisma as never, audit(), dnc());
    await service.record(tenantA, {
      contactRef: CONTACT,
      status: 'OPT_OUT',
      source: 'unsubscribe',
      lawfulBasis: 'consent_withdrawal',
    });
    const result = await service.eligibility(tenantA, {
      contactRef: CONTACT,
      countryCode: 'US',
      email: EMAIL,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('OUTREACH_OPTED_OUT');
  });

  it('DNC hit blocks an otherwise-eligible recipient', async () => {
    const prisma = new FakePrisma();
    const service = new OutreachConsentService(
      prisma as never,
      audit(),
      dnc(new Map([[EMAIL, ['global:complaint']]])),
    );
    const result = await service.eligibility(tenantA, {
      contactRef: CONTACT,
      countryCode: 'US',
      email: EMAIL,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('OUTREACH_DNC_BLOCKED');
  });

  it('negative 8: consent rows are workspace-scoped', async () => {
    const prisma = new FakePrisma();
    const service = new OutreachConsentService(prisma as never, audit(), dnc());
    await service.record(tenantA, {
      contactRef: CONTACT,
      status: 'OPT_IN',
      source: 'web_form',
      lawfulBasis: 'consent',
    });
    await expect(service.getLatest(tenantB, CONTACT)).rejects.toMatchObject({
      response: { error: { code: 'OUTREACH_CONSENT_NOT_FOUND' } },
    });
    await expect(service.getLatest(tenantA, CONTACT)).resolves.toMatchObject({
      workspaceId: WS_A,
    });
  });

  it('negative 6: invalid/expired tokens 404 and reuse is idempotent', async () => {
    const prisma = new FakePrisma();
    const service = new OutreachUnsubscribeService(prisma as never, audit());

    await expect(service.consume('not-a-valid-token')).rejects.toMatchObject({
      response: { error: { code: 'OUTREACH_UNSUBSCRIBE_TOKEN_INVALID' } },
    });

    const issued = await service.issue(tenantA, CONTACT);
    const first = await service.consume(issued.token);
    expect(first).toEqual({
      contactRef: CONTACT,
      workspaceId: WS_A,
      recipientEmail: null,
      alreadyUsed: false,
    });
    expect(prisma.consents).toHaveLength(1);
    expect(prisma.consents[0]).toMatchObject({
      workspaceId: WS_A,
      contactRef: CONTACT,
      status: 'OPT_OUT',
      source: 'unsubscribe',
    });

    const second = await service.consume(issued.token);
    expect(second).toEqual({
      contactRef: CONTACT,
      workspaceId: WS_A,
      recipientEmail: null,
      alreadyUsed: true,
    });
    expect(prisma.consents).toHaveLength(1);

    const expired = await service.issue(tenantA, CONTACT);
    const row = prisma.tokens.find((token) => token.id === expired.tokenId)!;
    row.expiresAt = new Date(Date.now() - 1000);
    await expect(service.consume(expired.token)).rejects.toMatchObject({
      response: { error: { code: 'OUTREACH_UNSUBSCRIBE_TOKEN_INVALID' } },
    });
  });
});

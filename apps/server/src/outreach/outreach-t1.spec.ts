import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { AuditService } from '../shared/audit.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import type { OutreachBatchService } from './outreach-batch.service.js';
import type { OutreachDncChecker } from './outreach-dnc.checker.js';
import type { DnsResolver } from './outreach-domain-dns.js';
import type { OutreachSendGate } from './outreach-send.gate.js';
import type { OutreachSendService } from './outreach-send.service.js';
import { OutreachT1Service } from './outreach-t1.service.js';

const TENANT = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'admin' as const,
};

const CONTACT_ID = '33333333-3333-4333-8333-333333333333';
const BATCH_ID = '44444444-4444-4444-8444-444444444444';

function makeFixture(options?: {
  sendEnabled?: boolean;
  shadowMode?: boolean;
  dncHits?: Record<string, string[]>;
  dncThrows?: boolean;
  consentStatus?: string | null;
  replies?: Array<{ kind: string; classification: string; receivedAt: Date }>;
  dnsResolver?: DnsResolver;
}) {
  const auditLogs: Array<Record<string, unknown>> = [];
  const auditRecords: Array<Record<string, unknown>> = [];
  const addedDrafts: Array<Record<string, unknown>> = [];

  const tx = {
    outreachConsent: {
      findFirst: vi.fn(async () =>
        options?.consentStatus ? { status: options.consentStatus } : null,
      ),
    },
    outreachReply: {
      findMany: vi.fn(async () => options?.replies ?? []),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: '55555555-5555-4555-8555-555555555555', at: new Date('2026-11-26T08:00:00Z'), ...data };
        auditLogs.push(row);
        return row;
      }),
      findMany: vi.fn(async () => auditLogs),
    },
  };

  const prisma = {
    withWorkspace: vi.fn(async (_wsId: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;

  const audit = {
    record: vi.fn(async (entry: Record<string, unknown>) => {
      auditRecords.push(entry);
    }),
  } as unknown as AuditService;

  const gate = {
    enabled: () => Boolean(options?.sendEnabled),
  } as unknown as OutreachSendGate;

  const batches = {
    addDraft: vi.fn(async (_tenant: unknown, batchId: string, input: Record<string, unknown>) => {
      const created = { id: '66666666-6666-4666-8666-666666666666', batchId, ...input };
      addedDrafts.push(created);
      return created;
    }),
  } as unknown as OutreachBatchService;

  const sends = {
    isShadowMode: () => options?.shadowMode ?? true,
  } as unknown as OutreachSendService;

  const config = {
    OUTREACH_SMTP_HOST: 'smtp.example.com',
    OUTREACH_SMTP_FROM_ADDRESS: 'outreach@send-domain.example',
  } as unknown as AppConfig;

  const dnc: OutreachDncChecker = {
    check: vi.fn(async (_tenant, emails) => {
      if (options?.dncThrows) throw new Error('engine unreachable');
      const map = new Map<string, string[]>();
      for (const e of emails) {
        const hits = options?.dncHits?.[e.toLowerCase()];
        if (hits) map.set(e.toLowerCase(), hits);
      }
      return map;
    }),
  };

  const dns: DnsResolver = options?.dnsResolver ?? {
    resolveTxt: vi.fn(async (name: string) => {
      if (name === 'send-domain.example') return [['v=spf1 include:_spf.google.com ~all']];
      if (name === '_dmarc.send-domain.example') return [['v=DMARC1; p=quarantine; rua=mailto:dmarc@send-domain.example']];
      if (name === 'google._domainkey.send-domain.example') return [['v=DKIM1; k=rsa; p=MIIBIj']];
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    }),
    resolveMx: vi.fn(async (name: string) => {
      if (name === 'send-domain.example') return [{ exchange: 'smtp.google.com', priority: 1 }];
      throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
    }),
  };

  const service = new OutreachT1Service(prisma, audit, gate, batches, sends, config, dnc, dns);
  return { service, tx, auditRecords, addedDrafts, prisma };
}

describe('OutreachT1Service', () => {
  it('returns readiness without leaking SMTP credentials', () => {
    const { service } = makeFixture({ sendEnabled: false, shadowMode: true });
    expect(service.getReadiness()).toEqual({
      sendEnabled: false,
      shadowMode: true,
      smtpConfigured: true,
      fromDomain: 'send-domain.example',
    });
  });

  it('checks SPF/DKIM/DMARC/MX via injected DNS resolver and rejects private/invalid domains', async () => {
    const { service } = makeFixture();
    const res = await service.checkDomainDns('Send-Domain.Example', 'google');
    expect(res.report.ready).toBe(true);
    expect(res.advice.score).toBe(4);
    expect(res.template).toContain('send-domain.example');

    await expect(service.checkDomainDns('localhost')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.checkDomainDns('127.0.0.1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.checkDomainDns('intranet.local')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('plans a 4-round sequence and dynamically hard-stops on new reply on subsequent listSequences()', async () => {
    const replies: Array<{ kind: string; classification: string; receivedAt: Date }> = [];
    const { service } = makeFixture({ replies });

    const created = await service.planSequence(TENANT, {
      contactRef: CONTACT_ID,
      recipientEmail: 'buyer@solar-it.example',
      companyName: 'SolarGrid Italia S.r.l.',
      countryCode: 'IT',
      subject: 'HJT 700W PV Supply',
      body: 'Hello team, sharing HJT 700W specs.',
      rounds: 4,
      startAt: '2026-11-26T08:00:00.000Z',
    });
    expect(created.plan.stopped).toBe(false);
    expect(created.plan.steps).toHaveLength(4);
    expect(created.recipientMasked).not.toContain('buyer@');

    // Simulate inbound reply arriving after sequence creation
    replies.push({ kind: 'REPLY', classification: 'POSITIVE', receivedAt: new Date('2026-11-27T09:00:00Z') });
    const listed = await service.listSequences(TENANT);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.plan.stopped).toBe(true);
    expect(listed[0]?.plan.stopReason).toBe('REPLY_RECEIVED');
  });

  it('creates referral follow-up draft for OPT_OUT jurisdiction (IT) and blocks DNC / strict D3 (DE) / DNC outage', async () => {
    const okFixture = makeFixture();
    const created = await okFixture.service.createReferralDraft(TENANT, {
      batchId: BATCH_ID,
      sourceContactRef: CONTACT_ID,
      referredEmail: 'purchasing@solar-it.example',
      companyName: 'SolarGrid Italia S.r.l.',
      countryCode: 'IT',
      subject: 'Re: Referred by colleague',
      body: 'Hello purchasing team, your colleague recommended we share our brochure.',
    });
    expect(created.newContactRef).not.toBe(CONTACT_ID);
    expect(okFixture.addedDrafts).toHaveLength(1);

    // D3 strict consent country (DE) must reject without prior opt-in
    await expect(
      okFixture.service.createReferralDraft(TENANT, {
        batchId: BATCH_ID,
        sourceContactRef: CONTACT_ID,
        referredEmail: 'einkauf@solar-de.example',
        companyName: 'Solar DE GmbH',
        countryCode: 'DE',
        subject: 'Referred intro',
        body: 'Hello team',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    // DNC suppression must reject
    const suppressedFixture = makeFixture({
      dncHits: { 'blocked@solar-it.example': ['tenant:dnc'] },
    });
    await expect(
      suppressedFixture.service.createReferralDraft(TENANT, {
        batchId: BATCH_ID,
        sourceContactRef: CONTACT_ID,
        referredEmail: 'blocked@solar-it.example',
        countryCode: 'IT',
        subject: 'Referred intro',
        body: 'Hello team',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    // DNC check outage must fail closed (503)
    const outageFixture = makeFixture({ dncThrows: true });
    await expect(
      outageFixture.service.createReferralDraft(TENANT, {
        batchId: BATCH_ID,
        sourceContactRef: CONTACT_ID,
        referredEmail: 'purchasing@solar-it.example',
        countryCode: 'IT',
        subject: 'Referred intro',
        body: 'Hello team',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

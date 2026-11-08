import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import type { AuditService } from '../shared/audit.service.js';
import {
  OutreachAuthorizationConsumer,
  hashOutreachAudience,
  hashOutreachDraftSet,
} from './outreach-authorization.consumer.js';
import { hashOutreachDrafts } from './outreach-content.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import { OutreachSendControls } from './outreach-send-controls.js';
import { OutreachSendGate } from './outreach-send.gate.js';
import { OutreachSendService } from './outreach-send.service.js';
import type { OutreachTransport } from './outreach-smtp.transport.js';

const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BATCH = '11111111-1111-4111-8111-111111111111';
const APPROVAL = '22222222-2222-4222-8222-222222222222';
const DRAFT_1 = '33333333-3333-4333-8333-333333333333';
const DRAFT_2 = '44444444-4444-4444-8444-444444444444';
const CONTACT_1 = '55555555-5555-4555-8555-555555555555';
const CONTACT_2 = '66666666-6666-4666-8666-666666666666';
const AUTHZ = '99999999-9999-4999-8999-999999999999';

const US_ADDRESS = 'GainOS Inc., 2261 Market Street #4000, San Francisco, CA 94114';
const FR_NOTICE =
  'Vos coordonnées professionnelles proviennent de sources publiques ; vous pouvez vous opposer à tout moment.';

// 2026-11-11 是周三，柏林 10:00（CET）。窗口/熔断/授权过期都以这个时刻为基准，测试与真实时钟解耦。
const WEDNESDAY_10_BERLIN = new Date('2026-11-11T09:00:00Z');
const WEDNESDAY_20_BERLIN = new Date('2026-11-11T19:00:00Z');
// 柏林 15:00 / 纽约 10:00：跨大西洋两边都在 09:00–17:00 窗口内。
const WEDNESDAY_15_BERLIN = new Date('2026-11-11T14:00:00Z');

const tenantA: OutreachTenant = { userId: 'user-a', workspaceId: WS_A, role: 'admin' };

interface Row {
  [key: string]: unknown;
}

function errorCode(error: unknown): string {
  return (error as { response?: { error?: { code?: string } } }).response?.error?.code ?? '';
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      const obj = condition as Record<string, unknown>;
      if ('in' in obj) return (obj.in as unknown[]).includes(row[key]);
      if ('not' in obj) return row[key] !== obj.not;
      if ('gte' in obj) return (row[key] as Date).getTime() >= (obj.gte as Date).getTime();
      if ('lt' in obj) return (row[key] as Date).getTime() < (obj.lt as Date).getTime();
      return true;
    }
    return row[key] === condition;
  });
}

class FakeSendPrisma {
  batches: Row[] = [];
  drafts: Row[] = [];
  approvals: Row[] = [];
  events: Row[] = [];
  sends: Row[] = [];
  packages: Row[] = [];
  consents: Row[] = [];
  authorizations: Row[] = [];
  replies: Row[] = [];
  seq = 0;

  private id(): string {
    return `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`;
  }

  private view(row: Row, include?: Row): Row {
    if (!include) return { ...row };
    const view: Row = { ...row };
    if (include.drafts) {
      view.drafts = this.drafts
        .filter((draft) => draft.batchId === row.id)
        .map((draft) => ({ ...draft }));
    }
    if (include.approvals) {
      const state = (include.approvals as { where?: { state?: string } }).where?.state;
      view.approvals = this.approvals
        .filter(
          (approval) => approval.batchId === row.id && (!state || approval.state === state),
        )
        .sort((a, b) => (b.decidedAt as Date).getTime() - (a.decidedAt as Date).getTime())
        .map((approval) => ({ ...approval }));
    }
    if (include.events) {
      view.events = this.events
        .filter((event) => event.batchId === row.id)
        .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime())
        .map((event) => ({ ...event }));
    }
    if (include.sends) {
      view.sends = this.sends
        .filter((send) => send.batchId === row.id)
        .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime())
        .map((send) => ({ ...send }));
    }
    return view;
  }

  readonly outreachBatch = {
    findFirst: async ({
      where,
      include,
    }: {
      where: { workspaceId?: string; id?: string };
      include?: Row;
    }) => {
      const row = this.batches.find(
        (batch) =>
          (!where.workspaceId || batch.workspaceId === where.workspaceId) &&
          (!where.id || batch.id === where.id),
      );
      return row ? this.view(row, include) : null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = this.batches.find((batch) => batch.id === where.id)!;
      Object.assign(row, data);
      return { ...row };
    },
  };

  readonly outreachDraft = {
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = this.drafts.find((draft) => draft.id === where.id)!;
      Object.assign(row, data);
      return { ...row };
    },
  };

  readonly outreachBatchEvent = {
    create: async ({ data }: { data: Row }) => {
      const row = { id: this.id(), createdAt: new Date(), ...data };
      this.events.push(row);
      return row;
    },
  };

  readonly outreachSend = {
    create: async ({ data }: { data: Row }) => {
      const row = { id: this.id(), createdAt: new Date(), ...data };
      this.sends.push(row);
      return row;
    },
    count: async ({ where }: { where: Row }) =>
      this.sends.filter((row) => matches(row, where)).length,
    findMany: async ({ where }: { where: Row }) =>
      this.sends.filter((row) => matches(row, where)),
    findFirst: async ({ where }: { where: Row }) =>
      this.sends.find((row) => matches(row, where)) ?? null,
  };

  readonly outreachReply = {
    count: async ({ where }: { where: Row }) =>
      this.replies.filter((row) => matches(row, where)).length,
  };

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
          (!where.state || candidate.state === where.state) &&
          (candidate.uses as number) < (where.uses as { lt: number }).lt,
      );
      if (!row) return { count: 0 };
      row.uses = (row.uses as number) + (data.uses as { increment: number }).increment;
      return { count: 1 };
    },
  };

  readonly outreachAuditPackage = {
    findFirst: async ({ where }: { where: Row }) =>
      this.packages.find(
        (row) =>
          row.batchId === where.batchId &&
          (!where.packageHash || row.packageHash === where.packageHash),
      ) ?? null,
    create: async ({ data }: { data: Row }) => {
      const row = { id: this.id(), createdAt: new Date(), ...data };
      this.packages.push(row);
      return row;
    },
  };

  readonly outreachConsent = {
    findMany: async ({ where }: { where: Row }) =>
      this.consents.filter(
        (row) =>
          row.workspaceId === where.workspaceId &&
          (where.contactRef as { in: string[] }).in.includes(row.contactRef as string),
      ),
  };

  readonly outreachUnsubscribeToken = {
    create: async ({ data }: { data: Row }) => ({ id: this.id(), ...data }),
  };

  readonly $transaction = async (
    operations: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>),
  ) => {
    if (typeof operations === 'function') return operations(this);
    return Promise.all(operations);
  };
}

function approvedBatch(
  prisma: FakeSendPrisma,
  options?: { expired?: boolean; countries?: [string | null, string | null] },
) {
  const countries = options?.countries ?? ['DE', 'DE'];
  const drafts = [
    {
      id: DRAFT_1,
      workspaceId: WS_A,
      batchId: BATCH,
      contactRef: CONTACT_1,
      recipientEmail: 'buyer@example.de',
      countryCode: countries[0],
      companyName: 'Beispiel GmbH',
      subject: 'Pumpen – kurze Frage',
      body: 'Guten Tag, ...',
      status: 'APPROVED',
      contentHash: '',
      approvedBy: 'approver@example.test',
      approvedAt: new Date('2026-11-08T09:00:00Z'),
      rejectionReason: null,
      createdAt: new Date('2026-11-08T08:00:00Z'),
      updatedAt: new Date('2026-11-08T09:00:00Z'),
    },
    {
      id: DRAFT_2,
      workspaceId: WS_A,
      batchId: BATCH,
      contactRef: CONTACT_2,
      recipientEmail: 'einkauf@example.de',
      countryCode: countries[1],
      companyName: 'Zweite AG',
      subject: 'Angebot',
      body: 'Hallo, ...',
      status: 'APPROVED',
      contentHash: '',
      approvedBy: 'approver@example.test',
      approvedAt: new Date('2026-11-08T09:00:00Z'),
      rejectionReason: null,
      createdAt: new Date('2026-11-08T08:10:00Z'),
      updatedAt: new Date('2026-11-08T09:00:00Z'),
    },
  ];
  const contentHash = hashOutreachDrafts(drafts);
  for (const draft of drafts) draft.contentHash = contentHash;
  prisma.drafts = drafts;
  prisma.batches = [
    {
      id: BATCH,
      workspaceId: WS_A,
      campaignId: null,
      authorizationId: AUTHZ,
      name: '德国泵业首触',
      status: 'QUEUED',
      contentHash,
      createdBy: 'user-a',
      submittedAt: new Date('2026-11-08T08:30:00Z'),
      decidedAt: new Date('2026-11-08T09:00:00Z'),
      queuedAt: new Date('2026-11-08T09:00:00Z'),
      createdAt: new Date('2026-11-08T08:00:00Z'),
      updatedAt: new Date('2026-11-08T09:00:00Z'),
    },
  ];
  prisma.approvals = [
    {
      id: APPROVAL,
      workspaceId: WS_A,
      batchId: BATCH,
      contentHash,
      state: 'APPROVED',
      requestedBy: 'user-a',
      decidedBy: 'approver@example.test',
      decidedAt: new Date('2026-11-08T09:00:00Z'),
      decisionReason: null,
      expiresAt: options?.expired
        ? new Date('2026-11-11T08:59:00Z')
        : new Date('2026-11-20T09:00:00Z'),
      createdAt: new Date('2026-11-08T08:30:00Z'),
    },
  ];
  prisma.consents = [
    {
      id: 'consent-1',
      workspaceId: WS_A,
      contactRef: CONTACT_1,
      channel: 'email',
      status: 'OPT_IN',
      source: 'web-form',
      lawfulBasis: 'consent',
      createdAt: new Date('2026-11-01T10:00:00Z'),
    },
    {
      id: 'consent-2',
      workspaceId: WS_A,
      contactRef: CONTACT_2,
      channel: 'email',
      status: 'OPT_IN',
      source: 'web-form',
      lawfulBasis: 'consent',
      createdAt: new Date('2026-11-01T10:05:00Z'),
    },
  ];
  prisma.authorizations = [
    authorizationFor(prisma, drafts.length, contentHash),
  ];
  return contentHash;
}

function authorizationFor(
  prisma: FakeSendPrisma,
  count: number,
  contentHash: string,
  overrides: Row = {},
): Row {
  const drafts = prisma.drafts.map((draft) => ({
    id: draft.id as string,
    contactRef: draft.contactRef as string,
    contentHash: draft.contentHash as string,
  }));
  const scope = {
    schemaVersion: 'campaign-authz/v2',
    actions: [
      {
        type: 'outreach.email.send',
        batchId: BATCH,
        audience: {
          contactRefsHash: hashOutreachAudience(drafts.map((draft) => draft.contactRef)),
          count: drafts.length,
          sizeCap: 50,
        },
        template: { contentHash, draftSetHash: hashOutreachDraftSet(drafts) },
        caps: { perMailboxDaily: 30, perMailboxWeekly: 120, perDomainHourly: 5, batchMax: 50 },
        schedule: {
          notBefore: new Date(Date.now() - 86_400_000).toISOString(),
          notAfter: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        },
        budget: { currency: 'USD', capMicros: 5_000_000 },
        jurisdiction: { allowedCountries: ['DE', 'US', 'FR'], deniedCountries: [] },
      },
    ],
  };
  return {
    id: AUTHZ,
    workspaceId: WS_A,
    campaignId: null,
    revisionId: 'rev-1',
    planHash: 'p'.repeat(64),
    scope,
    state: 'ISSUED',
    maxUses: count,
    uses: 0,
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    OUTREACH_SEND_BATCH_LIMIT: 50,
    OUTREACH_SMTP_FROM_ADDRESS: 'outreach@example.test',
    OUTREACH_UNSUBSCRIBE_BASE_URL: 'http://127.0.0.1:4020',
    OUTREACH_MAILBOX_DAILY_CAP: 30,
    OUTREACH_MAILBOX_WEEKLY_CAP: 120,
    OUTREACH_DOMAIN_HOURLY_CAP: 5,
    OUTREACH_BATCH_MAX_RECIPIENTS: 50,
    OUTREACH_SEND_WINDOW_START: '09:00',
    OUTREACH_SEND_WINDOW_END: '17:00',
    OUTREACH_SEND_WEEKDAYS: '1,2,3,4,5',
    OUTREACH_BOUNCE_WINDOW_DAYS: 7,
    OUTREACH_BOUNCE_MIN_SAMPLE: 20,
    OUTREACH_BOUNCE_RATE_HALT: 0.05,
    OUTREACH_COMPLAINT_MIN_SAMPLE: 100,
    OUTREACH_COMPLAINT_RATE_HALT: 0.003,
    OUTREACH_COST_PER_EMAIL_MICROS: 37_000,
    OUTREACH_US_POSTAL_ADDRESS: US_ADDRESS,
    OUTREACH_FR_SOURCE_NOTICE: FR_NOTICE,
    CAMPAIGN_EXECUTION_SHADOW: false,
    ...overrides,
  } as AppConfig;
}

function service(
  prisma: FakeSendPrisma,
  transport: OutreachTransport,
  enabled = true,
  dncReasons: Map<string, string[]> = new Map(),
  dncFails = false,
  configOverrides: Partial<AppConfig> = {},
) {
  const config = baseConfig(configOverrides);
  const gate = new OutreachSendGate({ OUTREACH_SEND_ENABLED: enabled } as AppConfig);
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const dnc = {
    check: vi.fn(async () => {
      if (dncFails) throw new Error('engine down');
      return dncReasons;
    }),
  };
  const unsubscribe = {
    issue: vi.fn(async () => ({
      token: 'test-unsubscribe-token-0123456789abcdef',
      expiresAt: new Date(Date.now() + 86_400_000),
      tokenId: 'token-id',
    })),
  };
  const controls = new OutreachSendControls(prisma as unknown as PrismaService, config);
  const authorization = new OutreachAuthorizationConsumer(
    prisma as unknown as PrismaService,
    config,
  );
  return new OutreachSendService(
    prisma as unknown as PrismaService,
    audit,
    gate,
    transport,
    dnc,
    unsubscribe as never,
    config,
    controls,
    authorization,
  );
}

function fakeTransport(
  behaviour: (message: { to: string; body?: string }) => Promise<{ messageId: string }> = async () => ({
    messageId: 'sink-message-id',
  }),
): OutreachTransport & { send: ReturnType<typeof vi.fn> } {
  return {
    ensureConfigured: vi.fn(),
    send: vi.fn(behaviour),
  } as unknown as OutreachTransport & { send: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(WEDNESDAY_10_BERLIN);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OutreachSendService', () => {
  it('发送开关默认关闭时拒绝，不写任何台账', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    const transport = fakeTransport();
    const gateService = service(prisma, transport, false);

    await expect(gateService.sendBatch(tenantA, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_SEND_DISABLED',
    );
    expect(transport.send).not.toHaveBeenCalled();
    expect(prisma.sends).toHaveLength(0);
  });

  it('负向：未批准的草稿不得发送，整批拒绝', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    prisma.drafts[0].approvedAt = null;
    const transport = fakeTransport();

    await expect(service(prisma, transport).sendBatch(tenantA, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_DRAFT_NOT_APPROVED',
    );
    expect(transport.send).not.toHaveBeenCalled();
    expect(prisma.sends).toHaveLength(0);
  });

  it('负向：批准过期后拒绝发送（重放/过期拒绝）', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma, { expired: true });
    const transport = fakeTransport();

    await expect(service(prisma, transport).sendBatch(tenantA, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_APPROVAL_EXPIRED',
    );
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('负向：批准后内容被改动，哈希不一致拒绝发送', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    prisma.drafts[0].subject = '改过的主题';
    const transport = fakeTransport();

    await expect(service(prisma, transport).sendBatch(tenantA, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_CONTENT_CHANGED',
    );
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('负向：批次已发送后重放请求被拒绝', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    prisma.batches[0].status = 'SENT';
    const transport = fakeTransport();

    await expect(service(prisma, transport).sendBatch(tenantA, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_BATCH_ALREADY_SENT',
    );
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('逐封发送成功：写台账（含授权消费）、更新草稿与批次，并持久化审计包', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    const transport = fakeTransport();

    const result = await service(prisma, transport).sendBatch(tenantA, BATCH);

    expect(result).toMatchObject({ status: 'SENT', sent: 2, failed: 0 });
    expect(transport.send).toHaveBeenCalledTimes(2);
    expect(prisma.sends).toHaveLength(2);
    expect(prisma.sends.every((send) => send.status === 'SENT')).toBe(true);
    expect(prisma.sends.map((send) => send.authorizationUse)).toEqual([1, 2]);
    expect(prisma.sends.every((send) => send.authorizationId === AUTHZ)).toBe(true);
    expect(prisma.authorizations[0].uses).toBe(2);
    expect(prisma.drafts.every((draft) => draft.status === 'SENT')).toBe(true);
    expect(prisma.batches[0].status).toBe('SENT');
    expect(prisma.packages.length).toBeGreaterThanOrEqual(2);
    const latest = prisma.packages[prisma.packages.length - 1];
    const auditPackage = latest.package as {
      batch: { authorizationId: string };
      approval: { decidedBy: string; decidedAt: string };
      drafts: Array<{
        subject: string;
        countryCode: string;
        jurisdictionPolicy: string;
        complianceBasis: { consentStatus: string; lawfulBasis: string };
      }>;
    };
    expect(auditPackage.batch.authorizationId).toBe(AUTHZ);
    expect(auditPackage.approval.decidedBy).toBe('approver@example.test');
    expect(auditPackage.drafts[0].subject).toBe('Pumpen – kurze Frage');
    expect(auditPackage.drafts[0].countryCode).toBe('DE');
    expect(auditPackage.drafts[0].jurisdictionPolicy).toBe('CONSENT_REQUIRED');
    expect(auditPackage.drafts[0].complianceBasis).toMatchObject({
      consentStatus: 'OPT_IN',
      lawfulBasis: 'consent',
    });

    await expect(service(prisma, transport).sendBatch(tenantA, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_BATCH_ALREADY_SENT',
    );
    expect(transport.send).toHaveBeenCalledTimes(2);
  });

  it('部分失败：失败封写 FAILED 台账，批次留在待发队列；重试只发失败封且不重复消费授权', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    let failFirst = true;
    const transport = fakeTransport(async (message) => {
      if (failFirst && message.to === 'buyer@example.de') {
        failFirst = false;
        throw new Error('sink refused');
      }
      return { messageId: `sink-${message.to}` };
    });

    const first = await service(prisma, transport).sendBatch(tenantA, BATCH);
    expect(first).toMatchObject({ status: 'QUEUED', sent: 1, failed: 1 });
    expect(prisma.batches[0].status).toBe('QUEUED');
    expect(prisma.sends.filter((send) => send.status === 'FAILED')).toHaveLength(1);
    expect(prisma.authorizations[0].uses).toBe(2);

    const second = await service(prisma, transport).sendBatch(tenantA, BATCH);
    expect(second).toMatchObject({ status: 'SENT', sent: 1, failed: 0 });
    expect(transport.send).toHaveBeenCalledTimes(3);
    expect(prisma.batches[0].status).toBe('SENT');
    // 重试沿用首次消费的序号：uses 不因重试增加。
    expect(prisma.authorizations[0].uses).toBe(2);
    const retried = prisma.sends.filter((send) => send.draftId === DRAFT_1);
    expect(retried.map((send) => send.authorizationUse)).toEqual([1, 1]);
  });

  it('DNC 命中：该封跳过并记录原因，其余照发，批次标记已完成', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    const transport = fakeTransport();
    const dncReasons = new Map([
      ['buyer@example.de', ['global:unsubscribe']],
    ]);

    const result = await service(prisma, transport, true, dncReasons).sendBatch(
      tenantA,
      BATCH,
    );

    expect(result).toMatchObject({ status: 'COMPLETED', sent: 1, failed: 0, skipped: 1 });
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(prisma.drafts[0].status).toBe('SKIPPED');
    expect(prisma.drafts[1].status).toBe('SENT');
    const skippedLedger = prisma.sends.find((send) => send.status === 'SKIPPED')!;
    expect(skippedLedger.error).toContain('OUTREACH_DNC_BLOCKED');
    expect(skippedLedger.authorizationUse).toBeFalsy();
    expect(prisma.batches[0].status).toBe('COMPLETED');
    expect(
      prisma.events.some((event) => event.type === 'DRAFT_SKIPPED'),
    ).toBe(true);
  });

  it('负向：退订（最新同意 OPT_OUT）后该封不再发送', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    prisma.consents[0].status = 'OPT_OUT';
    const transport = fakeTransport();

    const result = await service(prisma, transport).sendBatch(tenantA, BATCH);

    expect(result).toMatchObject({ status: 'COMPLETED', sent: 1, skipped: 1 });
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(prisma.sends.find((send) => send.status === 'SKIPPED')!.error).toBe(
      'OUTREACH_OPTED_OUT',
    );
  });

  it('负向：DNC 查询失败时 fail closed，整批不发送', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    const transport = fakeTransport();

    await expect(
      service(prisma, transport, true, new Map(), true).sendBatch(tenantA, BATCH),
    ).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_DNC_UNAVAILABLE',
    );
    expect(transport.send).not.toHaveBeenCalled();
    expect(prisma.sends).toHaveLength(0);
  });

  it('负向：批次已完成（含跳过）后重放被拒绝', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    prisma.batches[0].status = 'COMPLETED';
    const transport = fakeTransport();

    await expect(service(prisma, transport).sendBatch(tenantA, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_BATCH_ALREADY_COMPLETED',
    );
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('发送时附带退订链接与 List-Unsubscribe 头', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    const transport = fakeTransport();

    await service(prisma, transport).sendBatch(tenantA, BATCH);

    const firstCall = transport.send.mock.calls[0][0] as {
      body: string;
      headers: Record<string, string>;
    };
    expect(firstCall.body).toContain(
      'http://127.0.0.1:4020/api/public/outreach/unsubscribe?token=test-unsubscribe-token',
    );
    expect(firstCall.headers['List-Unsubscribe']).toContain('unsubscribe?token=');
    expect(firstCall.headers['List-Unsubscribe-Post']).toBe(
      'List-Unsubscribe=One-Click',
    );
  });

  it('审计包 hash 不含 generatedAt：重复读取命中持久化版本', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    await service(prisma, fakeTransport()).sendBatch(tenantA, BATCH);

    const first = await service(prisma, fakeTransport()).getAuditPackage(tenantA, BATCH);
    const second = await service(prisma, fakeTransport()).getAuditPackage(tenantA, BATCH);
    expect(first.packageHash).toBe(second.packageHash);
    expect(first.persistedAt).not.toBeNull();
  });

  it('门拒绝也落批次事件与审计包（13-1 G4）', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma, { expired: true });

    await expect(
      service(prisma, fakeTransport()).sendBatch(tenantA, BATCH),
    ).rejects.toSatisfy((error) => errorCode(error) === 'OUTREACH_APPROVAL_EXPIRED');

    expect(prisma.events.some((event) => event.type === 'BATCH_REJECTED')).toBe(true);
    expect(prisma.packages.length).toBeGreaterThan(0);
    expect(prisma.sends).toHaveLength(0);
  });

  it('审计包按 workspace 隔离：跨租户不可见', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    const serviceInstance = service(prisma, fakeTransport());

    await expect(
      serviceInstance.getAuditPackage(
        { userId: 'user-b', workspaceId: WS_B, role: 'admin' },
        BATCH,
      ),
    ).rejects.toSatisfy((error) => errorCode(error) === 'OUTREACH_BATCH_NOT_FOUND');
  });
});

describe('OutreachSendService · 法域同意门（P4-01）', () => {
  it('负向：DE 收件人无 OPT_IN 同意 → 该封跳过 JURISDICTION_CONSENT_REQUIRED，SMTP 不投递', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    prisma.consents = prisma.consents.filter((consent) => consent.contactRef !== CONTACT_1);
    const transport = fakeTransport();

    const result = await service(prisma, transport).sendBatch(tenantA, BATCH);

    expect(result).toMatchObject({ status: 'COMPLETED', sent: 1, skipped: 1 });
    expect(transport.send).toHaveBeenCalledTimes(1);
    const skipped = prisma.sends.find((send) => send.status === 'SKIPPED')!;
    expect(skipped.error).toBe('JURISDICTION_CONSENT_REQUIRED');
    const event = prisma.events.find(
      (row) => row.type === 'DRAFT_SKIPPED' && (row.detail as Row).draftId === DRAFT_1,
    )!;
    expect(event.detail).toMatchObject({
      countryCode: 'DE',
      jurisdictionPolicy: 'CONSENT_REQUIRED',
      code: 'JURISDICTION_CONSENT_REQUIRED',
    });
    expect(event.actor).toBe('user-a');
  });

  it('负向：草稿缺少收件人国家 → REVIEW_REQUIRED 跳过（fail-closed）', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma, { countries: [null, 'DE'] });
    const transport = fakeTransport();

    const result = await service(prisma, transport).sendBatch(tenantA, BATCH);
    expect(result).toMatchObject({ sent: 1, skipped: 1 });
    expect(prisma.sends.find((send) => send.status === 'SKIPPED')!.error).toBe(
      'JURISDICTION_REVIEW_REQUIRED',
    );
  });

  it('US 收件人（无同意记录）：CAN-SPAM opt-out 放行，正文带物理地址页脚', async () => {
    vi.setSystemTime(WEDNESDAY_15_BERLIN);
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma, { countries: ['US', 'US'] });
    prisma.consents = [];
    const transport = fakeTransport();

    const result = await service(prisma, transport).sendBatch(tenantA, BATCH);

    expect(result).toMatchObject({ status: 'SENT', sent: 2 });
    const body = (transport.send.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain(US_ADDRESS);
  });

  it('负向：US 未配置物理地址 → JURISDICTION_US_POSTAL_ADDRESS_REQUIRED 跳过', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma, { countries: ['US', 'US'] });
    prisma.consents = [];
    const transport = fakeTransport();

    const result = await service(prisma, transport, true, new Map(), false, {
      OUTREACH_US_POSTAL_ADDRESS: undefined,
    }).sendBatch(tenantA, BATCH);

    expect(result).toMatchObject({ sent: 0, skipped: 2 });
    expect(transport.send).not.toHaveBeenCalled();
    expect(prisma.sends.every((send) => send.error === 'JURISDICTION_US_POSTAL_ADDRESS_REQUIRED')).toBe(true);
  });

  it('FR 收件人（无同意记录）：CNIL 合法利益放行，正文带来源告知页脚', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma, { countries: ['FR', 'FR'] });
    prisma.consents = [];
    const transport = fakeTransport();

    const result = await service(prisma, transport).sendBatch(tenantA, BATCH);

    expect(result).toMatchObject({ status: 'SENT', sent: 2 });
    const body = (transport.send.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain(FR_NOTICE);
  });

  it('负向：FR 未配置来源告知 → JURISDICTION_FR_SOURCE_NOTICE_REQUIRED 跳过', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma, { countries: ['FR', 'FR'] });
    prisma.consents = [];
    const transport = fakeTransport();

    const result = await service(prisma, transport, true, new Map(), false, {
      OUTREACH_FR_SOURCE_NOTICE: undefined,
    }).sendBatch(tenantA, BATCH);

    expect(result).toMatchObject({ sent: 0, skipped: 2 });
    expect(transport.send).not.toHaveBeenCalled();
  });
});

describe('OutreachSendService · ExecutionAuthorization v2（P4-03）', () => {
  it('负向：批次未绑定执行授权 → 409 CAMPAIGN_AUTHORIZATION_INVALID，整批不发', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    prisma.batches[0].authorizationId = null;
    const transport = fakeTransport();

    await expect(service(prisma, transport).sendBatch(tenantA, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'CAMPAIGN_AUTHORIZATION_INVALID',
    );
    expect(transport.send).not.toHaveBeenCalled();
    expect(prisma.sends).toHaveLength(0);
  });

  it('负向：授权已撤销 → CAMPAIGN_AUTHORIZATION_REVOKED', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    prisma.authorizations[0].state = 'REVOKED';
    const transport = fakeTransport();

    await expect(service(prisma, transport).sendBatch(tenantA, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'CAMPAIGN_AUTHORIZATION_REVOKED',
    );
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('负向：授权已过期 → CAMPAIGN_AUTHORIZATION_EXPIRED', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    prisma.authorizations[0].expiresAt = new Date('2026-11-11T08:00:00Z');
    const transport = fakeTransport();

    await expect(service(prisma, transport).sendBatch(tenantA, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'CAMPAIGN_AUTHORIZATION_EXPIRED',
    );
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('负向：授权 scope 的内容哈希与批次不符 → OUTREACH_AUTHORIZATION_SCOPE_MISMATCH', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    const scope = prisma.authorizations[0].scope as {
      actions: Array<{ template: { contentHash: string } }>;
    };
    scope.actions[0].template.contentHash = 'b'.repeat(64);
    const transport = fakeTransport();

    await expect(service(prisma, transport).sendBatch(tenantA, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_AUTHORIZATION_SCOPE_MISMATCH',
    );
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('负向：授权计划窗口未到 → OUTREACH_SCHEDULE_OUT_OF_WINDOW', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    const scope = prisma.authorizations[0].scope as {
      actions: Array<{ schedule: { notBefore: string; notAfter: string } }>;
    };
    scope.actions[0].schedule = {
      notBefore: '2099-01-01T00:00:00Z',
      notAfter: '2099-12-31T00:00:00Z',
    };
    const transport = fakeTransport();

    await expect(service(prisma, transport).sendBatch(tenantA, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_SCHEDULE_OUT_OF_WINDOW',
    );
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('负向：授权剩余 uses 不足以覆盖待发数 → CAMPAIGN_AUTHORIZATION_USES_EXHAUSTED', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    prisma.authorizations[0].maxUses = 1;
    const transport = fakeTransport();

    await expect(service(prisma, transport).sendBatch(tenantA, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'CAMPAIGN_AUTHORIZATION_USES_EXHAUSTED',
    );
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('负向：预估成本超过授权预算 → OUTREACH_BUDGET_EXCEEDED', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    const scope = prisma.authorizations[0].scope as {
      actions: Array<{ budget: { currency: string; capMicros: number } }>;
    };
    scope.actions[0].budget = { currency: 'USD', capMicros: 1_000 };
    const transport = fakeTransport();

    await expect(service(prisma, transport).sendBatch(tenantA, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_BUDGET_EXCEEDED',
    );
    expect(transport.send).not.toHaveBeenCalled();
  });
});

describe('OutreachSendService · 控制面 v1（P4-02 服务层）', () => {
  it('负向：窗口外（当地 20:00）→ 顺延，不写台账、不投递，草稿保持待发', async () => {
    vi.setSystemTime(WEDNESDAY_20_BERLIN);
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    const transport = fakeTransport();

    const result = await service(prisma, transport).sendBatch(tenantA, BATCH);

    expect(result).toMatchObject({ status: 'QUEUED', sent: 0, deferred: 2 });
    expect(transport.send).not.toHaveBeenCalled();
    expect(prisma.sends).toHaveLength(0);
    expect(prisma.drafts.every((draft) => draft.status === 'APPROVED')).toBe(true);
    expect(prisma.batches[0].status).toBe('QUEUED');
    expect(
      prisma.events.filter((event) => event.type === 'DRAFT_DEFERRED'),
    ).toHaveLength(2);
    const deferred = prisma.events.find((event) => event.type === 'DRAFT_DEFERRED')!;
    expect(deferred.detail).toMatchObject({
      code: 'OUTREACH_WINDOW_CLOSED',
      countryCode: 'DE',
    });
  });

  it('负向：信箱当日已达上限 → 顺延 OUTREACH_MAILBOX_DAILY_CAP，不投递、不烧草稿', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    for (let index = 0; index < 30; index += 1) {
      prisma.sends.push({
        workspaceId: WS_A,
        batchId: 'other-batch',
        draftId: `other-draft-${index}`,
        recipientEmail: `k${index}@other-${index}.de`,
        mailboxAddress: 'outreach@example.test',
        status: 'SENT',
        sentAt: new Date(WEDNESDAY_10_BERLIN.getTime() - 60_000),
        authorizationUse: 1,
      });
    }
    const transport = fakeTransport();

    const result = await service(prisma, transport).sendBatch(tenantA, BATCH);

    expect(result).toMatchObject({ status: 'QUEUED', sent: 0, deferred: 2 });
    expect(transport.send).not.toHaveBeenCalled();
    expect(prisma.drafts.every((draft) => draft.status === 'APPROVED')).toBe(true);
    const deferred = prisma.events.filter((event) => event.type === 'DRAFT_DEFERRED');
    expect(deferred.every((event) => (event.detail as Row).code === 'OUTREACH_MAILBOX_DAILY_CAP')).toBe(true);
  });

  it('负向：同收件域本小时已满 5 封 → 顺延 OUTREACH_DOMAIN_RATE_LIMITED', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    for (let index = 0; index < 5; index += 1) {
      prisma.sends.push({
        workspaceId: WS_A,
        batchId: 'other-batch',
        draftId: `other-draft-${index}`,
        recipientEmail: `k${index}@example.de`,
        mailboxAddress: 'outreach@example.test',
        status: 'SENT',
        sentAt: new Date(WEDNESDAY_10_BERLIN.getTime() - 60_000),
        authorizationUse: 1,
      });
    }
    const transport = fakeTransport();

    const result = await service(prisma, transport).sendBatch(tenantA, BATCH);

    expect(result).toMatchObject({ status: 'QUEUED', sent: 0, deferred: 2 });
    expect(transport.send).not.toHaveBeenCalled();
    expect(prisma.events.filter((event) => event.type === 'DRAFT_DEFERRED')).toHaveLength(2);
  });

  it('负向：退信率超 5% 熔断 → 整批停发 OUTREACH_MAILBOX_PAUSED', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    for (let index = 0; index < 100; index += 1) {
      prisma.sends.push({
        workspaceId: WS_A,
        batchId: 'other-batch',
        draftId: `other-draft-${index}`,
        recipientEmail: `k${index}@ziel.de`,
        mailboxAddress: 'outreach@example.test',
        status: 'SENT',
        sentAt: new Date(WEDNESDAY_10_BERLIN.getTime() - 86_400_000),
        authorizationUse: 1,
      });
    }
    for (let index = 0; index < 6; index += 1) {
      prisma.replies.push({
        workspaceId: WS_A,
        kind: 'BOUNCE',
        receivedAt: new Date(WEDNESDAY_10_BERLIN.getTime() - 3_600_000),
      });
    }
    const transport = fakeTransport();

    await expect(service(prisma, transport).sendBatch(tenantA, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_MAILBOX_PAUSED',
    );
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('负向：投诉率超 0.3% 熔断 → 整批停发 OUTREACH_DOMAIN_PAUSED', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    for (let index = 0; index < 1_000; index += 1) {
      prisma.sends.push({
        workspaceId: WS_A,
        batchId: 'other-batch',
        draftId: `other-draft-${index}`,
        recipientEmail: `k${index}@ziel.de`,
        mailboxAddress: 'outreach@example.test',
        status: 'SENT',
        sentAt: new Date(WEDNESDAY_10_BERLIN.getTime() - 86_400_000),
        authorizationUse: 1,
      });
    }
    for (let index = 0; index < 4; index += 1) {
      prisma.replies.push({
        workspaceId: WS_A,
        kind: 'COMPLAINT',
        receivedAt: new Date(WEDNESDAY_10_BERLIN.getTime() - 3_600_000),
      });
    }
    const transport = fakeTransport();

    await expect(service(prisma, transport).sendBatch(tenantA, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_DOMAIN_PAUSED',
    );
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('负向：批次规模超过单批上限 → OUTREACH_BATCH_SIZE_EXCEEDED', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    const transport = fakeTransport();

    await expect(
      service(prisma, transport, true, new Map(), false, {
        OUTREACH_BATCH_MAX_RECIPIENTS: 1,
      }).sendBatch(tenantA, BATCH),
    ).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_BATCH_SIZE_EXCEEDED',
    );
    expect(transport.send).not.toHaveBeenCalled();
  });
});

describe('OutreachSendService · 影子模式（CAMPAIGN_EXECUTION_SHADOW，默认 on）', () => {
  it('影子模式：全部门序通过但只记录不发、不消费授权', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    const transport = fakeTransport();

    const result = await service(prisma, transport, true, new Map(), false, {
      CAMPAIGN_EXECUTION_SHADOW: true,
    }).sendBatch(tenantA, BATCH);

    expect(result).toMatchObject({
      status: 'QUEUED',
      sent: 0,
      failed: 0,
      shadowed: 2,
    });
    expect(transport.send).not.toHaveBeenCalled();
    expect(prisma.sends).toHaveLength(0);
    expect(prisma.authorizations[0].uses).toBe(0);
    expect(prisma.drafts.every((draft) => draft.status === 'APPROVED')).toBe(true);
    expect(
      prisma.events.filter((event) => event.type === 'SEND_SHADOWED'),
    ).toHaveLength(2);
  });
});

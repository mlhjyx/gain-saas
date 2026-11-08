import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import type { AuditService } from '../shared/audit.service.js';
import { hashOutreachDrafts } from './outreach-content.js';
import type { OutreachTenant } from './outreach-consent.service.js';
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

const tenantA: OutreachTenant = { userId: 'user-a', workspaceId: WS_A, role: 'admin' };

interface Row {
  [key: string]: unknown;
}

function errorCode(error: unknown): string {
  return (error as { response?: { error?: { code?: string } } }).response?.error?.code ?? '';
}

class FakeSendPrisma {
  batches: Row[] = [];
  drafts: Row[] = [];
  approvals: Row[] = [];
  events: Row[] = [];
  sends: Row[] = [];
  packages: Row[] = [];
  consents: Row[] = [];
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

  readonly $transaction = async (operations: Promise<unknown>[]) => Promise.all(operations);
}

function approvedBatch(prisma: FakeSendPrisma, options?: { expired?: boolean }) {
  const drafts = [
    {
      id: DRAFT_1,
      workspaceId: WS_A,
      batchId: BATCH,
      contactRef: CONTACT_1,
      recipientEmail: 'buyer@example.de',
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
        ? new Date('2026-11-08T09:01:00Z')
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
  ];
  return contentHash;
}

function service(
  prisma: FakeSendPrisma,
  transport: OutreachTransport,
  enabled = true,
  dncReasons: Map<string, string[]> = new Map(),
  dncFails = false,
) {
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
  const config = {
    OUTREACH_SEND_BATCH_LIMIT: 50,
    OUTREACH_SMTP_FROM_ADDRESS: 'outreach@example.test',
    OUTREACH_UNSUBSCRIBE_BASE_URL: 'http://127.0.0.1:4020',
  } as AppConfig;
  return new OutreachSendService(
    prisma as unknown as PrismaService,
    audit,
    gate,
    transport,
    dnc,
    unsubscribe as never,
    config,
  );
}

function fakeTransport(
  behaviour: (message: { to: string }) => Promise<{ messageId: string }> = async () => ({
    messageId: 'sink-message-id',
  }),
): OutreachTransport & { send: ReturnType<typeof vi.fn> } {
  return {
    ensureConfigured: vi.fn(),
    send: vi.fn(behaviour),
  } as unknown as OutreachTransport & { send: ReturnType<typeof vi.fn> };
}

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

  it('逐封发送成功：写台账、更新草稿与批次，并持久化审计包', async () => {
    const prisma = new FakeSendPrisma();
    approvedBatch(prisma);
    const transport = fakeTransport();

    const result = await service(prisma, transport).sendBatch(tenantA, BATCH);

    expect(result).toMatchObject({ status: 'SENT', sent: 2, failed: 0 });
    expect(transport.send).toHaveBeenCalledTimes(2);
    expect(prisma.sends).toHaveLength(2);
    expect(prisma.sends.every((send) => send.status === 'SENT')).toBe(true);
    expect(prisma.drafts.every((draft) => draft.status === 'SENT')).toBe(true);
    expect(prisma.batches[0].status).toBe('SENT');
    expect(prisma.packages.length).toBeGreaterThanOrEqual(2);
    const latest = prisma.packages[prisma.packages.length - 1];
    const auditPackage = latest.package as {
      approval: { decidedBy: string; decidedAt: string };
      drafts: Array<{
        subject: string;
        complianceBasis: { consentStatus: string; lawfulBasis: string };
      }>;
    };
    expect(auditPackage.approval.decidedBy).toBe('approver@example.test');
    expect(auditPackage.drafts[0].subject).toBe('Pumpen – kurze Frage');
    expect(auditPackage.drafts[0].complianceBasis).toMatchObject({
      consentStatus: 'OPT_IN',
      lawfulBasis: 'consent',
    });

    await expect(service(prisma, transport).sendBatch(tenantA, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_BATCH_ALREADY_SENT',
    );
    expect(transport.send).toHaveBeenCalledTimes(2);
  });

  it('部分失败：失败封写 FAILED 台账，批次留在待发队列；重试只发失败封', async () => {
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

    const second = await service(prisma, transport).sendBatch(tenantA, BATCH);
    expect(second).toMatchObject({ status: 'SENT', sent: 1, failed: 0 });
    expect(transport.send).toHaveBeenCalledTimes(3);
    expect(prisma.batches[0].status).toBe('SENT');
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

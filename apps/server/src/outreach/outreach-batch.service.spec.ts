import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { AppConfig } from '../config/configuration.js';
import { OutreachBatchService } from './outreach-batch.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';

const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONTACT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CONTACT_2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const tenantA: OutreachTenant = { userId: 'user-a', workspaceId: WS_A, role: 'admin' };
const tenantB: OutreachTenant = { userId: 'user-b', workspaceId: WS_B, role: 'admin' };

interface BatchRow {
  id: string;
  workspaceId: string;
  campaignId: string | null;
  name: string;
  status: string;
  contentHash: string | null;
  createdBy: string;
  submittedAt: Date | null;
  decidedAt: Date | null;
  queuedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
interface DraftRow {
  id: string;
  workspaceId: string;
  batchId: string;
  contactRef: string;
  recipientEmail: string;
  countryCode?: string | null;
  companyName: string | null;
  subject: string;
  body: string;
  status: string;
  contentHash: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}
interface ApprovalRow {
  id: string;
  workspaceId: string;
  batchId: string;
  contentHash: string;
  state: string;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  expiresAt: Date;
  createdAt: Date;
}
interface EventRow {
  id: string;
  workspaceId: string;
  batchId: string;
  type: string;
  actor: string;
  detail: unknown;
  createdAt: Date;
}

let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

class FakePrisma {
  batches: BatchRow[] = [];
  drafts: DraftRow[] = [];
  approvals: ApprovalRow[] = [];
  events: EventRow[] = [];

  private matchBatch(row: BatchRow, where: Record<string, unknown>): boolean {
    if (where.workspaceId && row.workspaceId !== where.workspaceId) return false;
    if (where.id && row.id !== where.id) return false;
    if (where.status && row.status !== where.status) return false;
    return true;
  }

  private batchView(row: BatchRow, include?: Record<string, unknown>) {
    if (!include) return { ...row };
    const view: Record<string, unknown> = { ...row };
    if (include.drafts) {
      view.drafts = this.drafts.filter((draft) => draft.batchId === row.id);
    }
    if (include.approvals) {
      const where = (include.approvals as { where?: { state?: string } }).where;
      view.approvals = this.approvals
        .filter(
          (approval) =>
            approval.batchId === row.id &&
            (!where?.state || approval.state === where.state),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }
    if (include.events) {
      view.events = this.events
        .filter((event) => event.batchId === row.id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    }
    if (include._count) {
      view._count = {
        drafts: this.drafts.filter((draft) => draft.batchId === row.id).length,
      };
    }
    return view;
  }

  readonly outreachBatch = {
    create: async ({ data }: { data: Omit<BatchRow, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'submittedAt' | 'decidedAt' | 'queuedAt' | 'contentHash'> }) => {
      const row: BatchRow = {
        id: id(),
        status: 'DRAFT',
        contentHash: null,
        submittedAt: null,
        decidedAt: null,
        queuedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      this.batches.push(row);
      return { ...row };
    },
    findFirst: async ({
      where,
      include,
    }: {
      where: Record<string, unknown>;
      include?: Record<string, unknown>;
    }) => {
      const row = this.batches.find((batch) => this.matchBatch(batch, where));
      return row ? this.batchView(row, include) : null;
    },
    findMany: async ({
      where,
      include,
    }: {
      where: Record<string, unknown>;
      include?: Record<string, unknown>;
    }) =>
      this.batches
        .filter((batch) => this.matchBatch(batch, where))
        .map((batch) => this.batchView(batch, include)),
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<BatchRow>;
    }) => {
      const row = this.batches.find((batch) => batch.id === where.id)!;
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    },
  };

  readonly outreachDraft = {
    count: async ({ where }: { where: Record<string, unknown> }) =>
      this.drafts.filter((draft) => !where.batchId || draft.batchId === where.batchId).length,
    create: async ({ data }: { data: Omit<DraftRow, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'contentHash' | 'approvedBy' | 'approvedAt' | 'rejectionReason'> }) => {
      if (this.drafts.some((draft) => draft.batchId === data.batchId && draft.contactRef === data.contactRef)) {
        throw new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      const row: DraftRow = {
        id: id(),
        status: 'DRAFT',
        contentHash: null,
        approvedBy: null,
        approvedAt: null,
        rejectionReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      this.drafts.push(row);
      return { ...row };
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      this.drafts.find(
        (draft) =>
          (!where.id || draft.id === where.id) &&
          (!where.batchId || draft.batchId === where.batchId) &&
          (!where.workspaceId || draft.workspaceId === where.workspaceId),
      ) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Partial<DraftRow> }) => {
      const row = this.drafts.find((draft) => draft.id === where.id)!;
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Partial<DraftRow>;
    }) => {
      let count = 0;
      for (const draft of this.drafts) {
        if (where.batchId && draft.batchId !== where.batchId) continue;
        if (where.status && draft.status !== where.status) continue;
        Object.assign(draft, data, { updatedAt: new Date() });
        count += 1;
      }
      return { count };
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const before = this.drafts.length;
      this.drafts = this.drafts.filter(
        (draft) =>
          !(
            draft.id === where.id &&
            draft.batchId === where.batchId &&
            draft.workspaceId === where.workspaceId
          ),
      );
      return { count: before - this.drafts.length };
    },
  };

  readonly outreachBatchApproval = {
    create: async ({ data }: { data: Omit<ApprovalRow, 'id' | 'state' | 'decidedBy' | 'decidedAt' | 'decisionReason' | 'createdAt'> }) => {
      const row: ApprovalRow = {
        id: id(),
        state: 'PENDING',
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        createdAt: new Date(),
        ...data,
      };
      this.approvals.push(row);
      return { ...row };
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      const now = (where.expiresAt as { lte?: Date } | undefined)?.lte;
      return (
        this.approvals.find(
          (approval) =>
            (!where.id || approval.id === where.id) &&
            (!where.batchId || approval.batchId === where.batchId) &&
            (!where.workspaceId || approval.workspaceId === where.workspaceId) &&
            (!where.state || approval.state === where.state) &&
            (!now || approval.expiresAt.getTime() <= now.getTime()),
        ) ?? null
      );
    },
    findMany: async ({ where }: { where: Record<string, unknown> }) => {
      const now = (where.expiresAt as { lte?: Date } | undefined)?.lte;
      return this.approvals.filter(
        (approval) =>
          (!where.workspaceId || approval.workspaceId === where.workspaceId) &&
          (!where.state || approval.state === where.state) &&
          (!now || approval.expiresAt.getTime() <= now.getTime()),
      );
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<ApprovalRow> }) => {
      const row = this.approvals.find((approval) => approval.id === where.id)!;
      Object.assign(row, data);
      return { ...row };
    },
  };

  readonly outreachBatchEvent = {
    create: async ({ data }: { data: Omit<EventRow, 'id' | 'createdAt'> }) => {
      const row: EventRow = { id: id(), createdAt: new Date(), ...data };
      this.events.push(row);
      return { ...row };
    },
  };

  async $transaction<T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function build(prisma = new FakePrisma(), configOverrides: Partial<AppConfig> = {}) {
  const audit = { record: vi.fn(async () => undefined) } as never;
  const config = { OUTREACH_APPROVAL_TTL_HOURS: 72, ...configOverrides } as AppConfig;
  return {
    prisma,
    service: new OutreachBatchService(prisma as never, audit, config),
  };
}

const draftInput = (contactRef = CONTACT, subject = '交期缩短方案') => ({
  contactRef,
  recipientEmail: 'Buyer@Example.com',
  companyName: 'Northwind',
  subject,
  body: '你好，我们能把交期缩短到 4 周。',
});

describe('OutreachBatchService', () => {
  it('submits, approves and queues a batch; drafts become approved', async () => {
    const { service, prisma } = build();
    const batch = await service.createBatch(tenantA, { name: '首触批次' });
    await service.addDraft(tenantA, batch.id, draftInput());

    const approval = await service.submitBatch(tenantA, batch.id);
    let detail = await service.getBatch(tenantA, batch.id);
    expect(detail.status).toBe('PENDING_APPROVAL');
    expect(detail.drafts[0]?.status).toBe('PENDING_APPROVAL');
    expect(detail.contentHash).toMatch(/^[0-9a-f]{64}$/);

    detail = await service.decideApproval(tenantA, batch.id, approval.id, {
      decision: 'approve',
    });
    expect(detail.status).toBe('QUEUED');
    expect(detail.drafts[0]?.status).toBe('APPROVED');
    expect(detail.drafts[0]?.approvedBy).toBe('user-a');
    expect(prisma.events.map((event) => event.type)).toEqual([
      'BATCH_CREATED',
      'DRAFT_ADDED',
      'BATCH_SUBMITTED',
      'BATCH_APPROVED',
    ]);
  });

  it('declines and reopens; an edit changes the content hash on resubmission', async () => {
    const { service } = build();
    const batch = await service.createBatch(tenantA, { name: '批次' });
    const draft = await service.addDraft(tenantA, batch.id, draftInput());
    const first = await service.submitBatch(tenantA, batch.id);
    const firstHash = (await service.getBatch(tenantA, batch.id)).contentHash;

    await service.decideApproval(tenantA, batch.id, first.id, { decision: 'decline' });
    expect((await service.getBatch(tenantA, batch.id)).status).toBe('DECLINED');

    await service.reopenBatch(tenantA, batch.id);
    await service.updateDraft(tenantA, batch.id, draft.id, draftInput(CONTACT, '新的主题'));
    const second = await service.submitBatch(tenantA, batch.id);
    const secondHash = (await service.getBatch(tenantA, batch.id)).contentHash;
    expect(secondHash).not.toBe(firstHash);
    expect(second.id).not.toBe(first.id);
  });

  it('freezes drafts after submission and rejects edits', async () => {
    const { service } = build();
    const batch = await service.createBatch(tenantA, { name: '批次' });
    await service.addDraft(tenantA, batch.id, draftInput());
    await service.submitBatch(tenantA, batch.id);
    await expect(
      service.addDraft(tenantA, batch.id, draftInput(CONTACT_2)),
    ).rejects.toMatchObject({ response: { error: { code: 'OUTREACH_BATCH_NOT_DRAFT' } } });
  });

  it('lazily expires stale approvals and rejects late decisions', async () => {
    const { service, prisma } = build();
    const batch = await service.createBatch(tenantA, { name: '批次' });
    await service.addDraft(tenantA, batch.id, draftInput());
    const approval = await service.submitBatch(tenantA, batch.id);
    const row = prisma.approvals.find((item) => item.id === approval.id)!;
    row.expiresAt = new Date(Date.now() - 1000);

    const detail = await service.getBatch(tenantA, batch.id);
    expect(detail.status).toBe('EXPIRED');
    expect(detail.drafts[0]?.status).toBe('REJECTED');
    await expect(
      service.decideApproval(tenantA, batch.id, approval.id, { decision: 'approve' }),
    ).rejects.toMatchObject({ response: { error: { code: 'OUTREACH_APPROVAL_NOT_PENDING' } } });
  });

  it('negative 8: batches are workspace-scoped', async () => {
    const { service } = build();
    const batch = await service.createBatch(tenantA, { name: '批次' });
    await expect(service.getBatch(tenantB, batch.id)).rejects.toMatchObject({
      response: { error: { code: 'OUTREACH_BATCH_NOT_FOUND' } },
    });
  });

  it('records self-approval in the event detail', async () => {
    const { service, prisma } = build();
    const batch = await service.createBatch(tenantA, { name: '批次' });
    await service.addDraft(tenantA, batch.id, draftInput());
    const approval = await service.submitBatch(tenantA, batch.id);
    await service.decideApproval(tenantA, batch.id, approval.id, { decision: 'approve' });
    const approved = prisma.events.find((event) => event.type === 'BATCH_APPROVED')!;
    expect(approved.detail).toMatchObject({ selfApproval: true });
  });

  it('draft countryCode：小写归一化为大写入库，非法国家代码拒绝（法域门输入）', async () => {
    const { service } = build();
    const batch = await service.createBatch(tenantA, { name: '德国首触' });
    const draft = await service.addDraft(tenantA, batch.id, {
      ...draftInput(),
      countryCode: 'de',
    });
    expect(draft.countryCode).toBe('DE');

    await expect(
      service.addDraft(tenantA, batch.id, {
        ...draftInput(CONTACT_2),
        countryCode: 'DEU',
      }),
    ).rejects.toSatisfy(
      (error) =>
        (error as { response?: { error?: { code?: string } } }).response?.error?.code ===
        'VALIDATION_ERROR',
    );
  });

  it('编辑草稿未带 countryCode 时保留原值（PATCH 语义，不被整体替换清空）', async () => {
    const { service } = build();
    const batch = await service.createBatch(tenantA, { name: '法国首触' });
    const draft = await service.addDraft(tenantA, batch.id, {
      ...draftInput(),
      countryCode: 'FR',
    });
    const updated = await service.updateDraft(tenantA, batch.id, draft.id, {
      ...draftInput(),
      subject: '新的主题',
    });
    expect(updated.subject).toBe('新的主题');
    expect(updated.countryCode).toBe('FR');

    const cleared = await service.updateDraft(tenantA, batch.id, draft.id, {
      ...draftInput(),
      countryCode: null,
    });
    expect(cleared.countryCode).toBeNull();
  });

  it('负向：单批收件人超过上限时建草稿即拒绝（M2 D-11-d ≤50）', async () => {
    const { service } = build(new FakePrisma(), { OUTREACH_BATCH_MAX_RECIPIENTS: 1 });
    const batch = await service.createBatch(tenantA, { name: '小批' });
    await service.addDraft(tenantA, batch.id, draftInput());
    await expect(
      service.addDraft(tenantA, batch.id, draftInput(CONTACT_2)),
    ).rejects.toSatisfy(
      (error) =>
        (error as { response?: { error?: { code?: string } } }).response?.error?.code ===
        'OUTREACH_BATCH_SIZE_EXCEEDED',
    );
  });
});

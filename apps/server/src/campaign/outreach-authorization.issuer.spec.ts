import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { AuditService } from '../shared/audit.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import { OutreachAuthorizationConsumer } from '../outreach/outreach-authorization.consumer.js';
import type { OutreachTenant } from '../outreach/outreach-consent.service.js';
import { hashOutreachDrafts } from '../outreach/outreach-content.js';
import { OutreachAuthorizationIssuer } from './outreach-authorization.issuer.js';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BATCH = '11111111-1111-4111-8111-111111111111';
const APPROVAL = '22222222-2222-4222-8222-222222222222';
const DRAFT_1 = '33333333-3333-4333-8333-333333333333';
const DRAFT_2 = '44444444-4444-4444-8444-444444444444';
const CONTACT_1 = '55555555-5555-4555-8555-555555555555';
const CONTACT_2 = '66666666-6666-4666-8666-666666666666';
const tenant: OutreachTenant = { userId: 'user-a', workspaceId: WS, role: 'admin' };

interface Row {
  [key: string]: unknown;
}

class FakePrisma {
  batches: Row[] = [];
  authorizations: Row[] = [];
  events: Row[] = [];
  sends: Row[] = [];
  seq = 0;

  private id(): string {
    return `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`;
  }

  readonly outreachBatch = {
    findFirst: async ({ where, include }: { where: Row; include?: Row }) => {
      const row = this.batches.find(
        (batch) =>
          (!where.id || batch.id === where.id) &&
          (!where.workspaceId || batch.workspaceId === where.workspaceId),
      );
      if (!row) return null;
      const view: Row = { ...row };
      if (include?.drafts) view.drafts = row.drafts;
      if (include?.approvals) view.approvals = row.approvals;
      return view;
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = this.batches.find((batch) => batch.id === where.id)!;
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

  readonly campaignExecutionAuthorization = {
    create: async ({ data }: { data: Row }) => {
      const row = { createdAt: new Date(), ...data };
      this.authorizations.push(row);
      return { ...row };
    },
    findFirst: async ({ where }: { where: Row }) =>
      this.authorizations.find(
        (row) =>
          (!where.id || row.id === where.id) &&
          (!where.workspaceId || row.workspaceId === where.workspaceId) &&
          (!where.state || row.state === where.state),
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

  readonly outreachSend = {
    findMany: async ({ where }: { where: Row }) =>
      this.sends.filter(
        (row) =>
          row.batchId === where.batchId &&
          (where.draftId as { in: string[] }).in.includes(row.draftId as string) &&
          row.authorizationUse !== null &&
          row.authorizationUse !== undefined,
      ),
    findFirst: async ({ where }: { where: Row }) =>
      this.sends.find(
        (row) =>
          row.batchId === where.batchId &&
          row.draftId === where.draftId &&
          (!where.authorizationId || row.authorizationId === where.authorizationId) &&
          row.authorizationUse !== null &&
          row.authorizationUse !== undefined,
      ) ?? null,
  };

  readonly $transaction = async (
    operations: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>),
  ) => {
    if (typeof operations === 'function') return operations(this);
    return Promise.all(operations);
  };
}

function fixture(prisma: FakePrisma, options: { campaignId?: string | null; expired?: boolean } = {}) {
  const drafts = [
    {
      id: DRAFT_1,
      workspaceId: WS,
      batchId: BATCH,
      contactRef: CONTACT_1,
      recipientEmail: 'buyer@example.de',
      countryCode: 'DE',
      subject: 'Pumpen',
      body: 'Guten Tag',
      status: 'APPROVED',
      contentHash: '',
      approvedBy: 'approver',
      approvedAt: new Date('2026-11-08T09:00:00Z'),
      createdAt: new Date('2026-11-08T08:00:00Z'),
    },
    {
      id: DRAFT_2,
      workspaceId: WS,
      batchId: BATCH,
      contactRef: CONTACT_2,
      recipientEmail: 'buyer@example.com',
      countryCode: 'US',
      subject: 'Pumps',
      body: 'Hello',
      status: 'APPROVED',
      contentHash: '',
      approvedBy: 'approver',
      approvedAt: new Date('2026-11-08T09:00:00Z'),
      createdAt: new Date('2026-11-08T08:10:00Z'),
    },
  ];
  const contentHash = hashOutreachDrafts(drafts);
  for (const draft of drafts) draft.contentHash = contentHash;
  prisma.batches = [
    {
      id: BATCH,
      workspaceId: WS,
      campaignId: options.campaignId ?? null,
      authorizationId: null,
      name: '批次',
      status: 'QUEUED',
      contentHash,
      drafts,
      approvals: [
        {
          id: APPROVAL,
          batchId: BATCH,
          contentHash,
          state: 'APPROVED',
          expiresAt: options.expired
            ? new Date(Date.now() - 1000)
            : new Date(Date.now() + 86_400_000),
        },
      ],
    },
  ];
  return { drafts, contentHash };
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    OUTREACH_MAILBOX_DAILY_CAP: 30,
    OUTREACH_MAILBOX_WEEKLY_CAP: 120,
    OUTREACH_DOMAIN_HOURLY_CAP: 5,
    OUTREACH_BATCH_MAX_RECIPIENTS: 50,
    OUTREACH_COST_PER_EMAIL_MICROS: 37_000,
    OUTREACH_AUTHZ_TTL_MINUTES: 10_080,
    OUTREACH_AUTHZ_SCHEDULE_DAYS: 7,
    ...overrides,
  } as AppConfig;
}

function build(prisma = new FakePrisma(), overrides: Partial<AppConfig> = {}) {
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const signer = { sign: vi.fn(async () => 'signed-token') };
  const issuer = new OutreachAuthorizationIssuer(
    prisma as unknown as PrismaService,
    signer as never,
    audit,
    config(overrides),
  );
  const consumer = new OutreachAuthorizationConsumer(
    prisma as unknown as PrismaService,
    config(overrides),
  );
  return { prisma, issuer, consumer, signer, audit };
}

function errorCode(error: unknown): string {
  return (error as { response?: { error?: { code?: string } } }).response?.error?.code ?? '';
}

describe('OutreachAuthorizationIssuer（P4-03 签发侧）', () => {
  it('签发：v2 scope 派生自批准事实，批次绑定，签发→消费端到端通过', async () => {
    const ctx = build();
    const { drafts, contentHash } = fixture(ctx.prisma);

    const result = await ctx.issuer.issue(tenant, BATCH);

    expect(result.created).toBe(true);
    const authorization = result.authorization as Row;
    expect(authorization).toMatchObject({
      workspaceId: WS,
      state: 'ISSUED',
      maxUses: 2,
      planHash: contentHash,
    });
    // 无 campaign 的独立批次：claims/行上的 campaignId 用批次自身承载。
    expect(authorization.campaignId).toBe(BATCH);
    const scope = authorization.scope as Row;
    expect(scope.schemaVersion).toBe('campaign-authz/v2');
    const action = (scope.actions as Row[])[0] as Row;
    expect(action).toMatchObject({ type: 'outreach.email.send', batchId: BATCH });
    expect((action.audience as Row).count).toBe(2);
    expect((action.caps as Row).perMailboxDaily).toBe(30);
    expect((action.budget as Row).capMicros).toBe(2 * 37_000);
    expect((action.jurisdiction as Row).allowedCountries).toEqual(['DE', 'US']);

    // 批次改绑 + 事件 + 签名调用。
    expect(ctx.prisma.batches[0].authorizationId).toBe(authorization.id);
    expect(ctx.prisma.events.some((event) => event.type === 'AUTHORIZATION_ISSUED')).toBe(true);
    expect(ctx.signer.sign).toHaveBeenCalledTimes(1);
    const claims = ctx.signer.sign.mock.calls[0][0] as Row;
    expect(claims).toMatchObject({ workspaceId: WS, campaignId: BATCH, planHash: contentHash });

    // 签发端与消费端使用同一哈希实现：消费端可直接通过。
    const grant = await ctx.consumer.authorizeBatch(
      tenant,
      ctx.prisma.batches[0] as never,
      drafts as never,
      [DRAFT_1, DRAFT_2],
    );
    expect(grant).toMatchObject({ authorizationId: authorization.id, remainingUses: 2 });
  });

  it('幂等：已绑定未过期 ISSUED 授权时原样返回、不重复签发', async () => {
    const ctx = build();
    fixture(ctx.prisma);
    const first = await ctx.issuer.issue(tenant, BATCH);
    const second = await ctx.issuer.issue(tenant, BATCH);
    expect(second.created).toBe(false);
    expect((second.authorization as Row).id).toBe((first.authorization as Row).id);
    expect(ctx.prisma.authorizations).toHaveLength(1);
    expect(ctx.signer.sign).toHaveBeenCalledTimes(1);
  });

  it('改绑：原授权 REVOKED 后重新签发新授权并替换批次绑定', async () => {
    const ctx = build();
    fixture(ctx.prisma);
    const first = await ctx.issuer.issue(tenant, BATCH);
    (ctx.prisma.authorizations[0] as Row).state = 'REVOKED';
    const second = await ctx.issuer.issue(tenant, BATCH);
    expect(second.created).toBe(true);
    expect((second.authorization as Row).id).not.toBe((first.authorization as Row).id);
    expect(ctx.prisma.authorizations).toHaveLength(2);
    expect(ctx.prisma.batches[0].authorizationId).toBe((second.authorization as Row).id);
  });

  it('负向：批次未入队 / 批准过期 / 内容哈希不符 一律拒绝签发', async () => {
    const notQueued = build();
    fixture(notQueued.prisma);
    notQueued.prisma.batches[0].status = 'DRAFT';
    await expect(notQueued.issuer.issue(tenant, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_BATCH_NOT_QUEUED',
    );

    const expired = build();
    fixture(expired.prisma, { expired: true });
    await expect(expired.issuer.issue(tenant, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_APPROVAL_EXPIRED',
    );

    const changed = build();
    const { drafts } = fixture(changed.prisma);
    drafts[0].body = '改过的正文';
    await expect(changed.issuer.issue(tenant, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_CONTENT_CHANGED',
    );

    const missing = build();
    fixture(missing.prisma);
    missing.prisma.batches[0].approvals = [];
    await expect(missing.issuer.issue(tenant, BATCH)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_APPROVAL_MISSING',
    );
  });

  it('有 campaign 的批次：claims 与 scope 使用 campaignId；TTL 不超过计划窗口', async () => {
    const ctx = build(new FakePrisma(), { OUTREACH_AUTHZ_TTL_MINUTES: 20_160, OUTREACH_AUTHZ_SCHEDULE_DAYS: 3 });
    fixture(ctx.prisma, { campaignId: '77777777-7777-4777-8777-777777777777' });
    const result = await ctx.issuer.issue(tenant, BATCH);
    const authorization = result.authorization as Row;
    expect(authorization.campaignId).toBe('77777777-7777-4777-8777-777777777777');
    const action = ((authorization.scope as Row).actions as Row[])[0] as Row;
    const notAfter = new Date(String((action.schedule as Row).notAfter)).getTime();
    const expiresAt = (authorization.expiresAt as Date).getTime();
    expect(expiresAt).toBeLessThanOrEqual(notAfter);
    expect(notAfter - Date.now()).toBeLessThanOrEqual(3 * 86_400_000 + 5_000);
    const claims = ctx.signer.sign.mock.calls[0][0] as Row;
    expect((claims.scope as Row).campaignId).toBe('77777777-7777-4777-8777-777777777777');
  });
});

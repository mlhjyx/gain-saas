import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../shared/audit.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import { OutreachLegalReviewsService } from './outreach-legal-reviews.service.js';
import { OutreachTemplatesService } from './outreach-templates.service.js';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const tenant: OutreachTenant = { userId: 'user-a', workspaceId: WS, role: 'admin' };

interface Row {
  [key: string]: unknown;
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      const obj = condition as Record<string, unknown>;
      if ('not' in obj) return row[key] !== obj.not;
      if ('in' in obj) return (obj.in as unknown[]).includes(row[key]);
      return true;
    }
    return row[key] === condition;
  });
}

class FakeTemplatesPrisma {
  reviews: Row[] = [];
  templates: Row[] = [];
  seq = 0;

  private id(): string {
    return `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`;
  }

  readonly legalReview = {
    create: async ({ data }: { data: Row }) => {
      const row = { id: this.id(), createdAt: new Date(), ...data };
      this.reviews.push(row);
      return { ...row };
    },
    findFirst: async ({ where }: { where: Row }) =>
      this.reviews.find((row) => matches(row, where)) ?? null,
    findMany: async ({ where }: { where: Row }) =>
      this.reviews.filter((row) => matches(row, where)),
  };

  readonly outreachTemplateVersion = {
    create: async ({ data }: { data: Row }) => {
      const row = { id: this.id(), createdAt: new Date(), ...data };
      this.templates.push(row);
      return { ...row };
    },
    findFirst: async ({
      where,
      orderBy,
    }: {
      where: Row;
      orderBy?: { version?: 'asc' | 'desc' };
    }) => {
      const rows = this.templates.filter((row) => matches(row, where));
      if (orderBy?.version === 'desc') {
        rows.sort((a, b) => (b.version as number) - (a.version as number));
      }
      return rows[0] ?? null;
    },
    findMany: async ({ where }: { where: Row }) =>
      this.templates.filter((row) => matches(row, where)),
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = this.templates.find((candidate) => candidate.id === where.id)!;
      Object.assign(row, data);
      return { ...row };
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = this.templates.filter((row) => matches(row, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    },
  };

  readonly $transaction = async (
    operations: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>),
  ) => {
    if (typeof operations === 'function') return operations(this);
    return Promise.all(operations);
  };
}

function build(prisma = new FakeTemplatesPrisma()) {
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  return {
    prisma,
    templates: new OutreachTemplatesService(prisma as unknown as PrismaService, audit),
    reviews: new OutreachLegalReviewsService(prisma as unknown as PrismaService, audit),
  };
}

function errorCode(error: unknown): string {
  return (error as { response?: { error?: { code?: string } } }).response?.error?.code ?? '';
}

const emailTemplate = {
  kind: 'email_first',
  jurisdiction: 'de' as const,
  language: 'de',
  subject: 'Pumpen – kurze Frage',
  body: 'Guten Tag, ...',
};

async function approvedReviewFor(
  ctx: ReturnType<typeof build>,
  documentHash: string,
  overrides: Row = {},
) {
  return ctx.reviews.create(tenant, {
    subjectKind: 'email_template',
    documentHash,
    reviewerName: 'Dr. Beispiel',
    reviewerFirm: 'Kanzlei Beispiel',
    reviewedAt: '2026-11-10T00:00:00Z',
    scope: 'DE 邮件首触模板 v1',
    verdict: 'APPROVED',
    documentRef: 's3://legal/de-email-v1.pdf',
    ...overrides,
  });
}

describe('OutreachTemplatesService（P4-05 模板版本化与法审占位）', () => {
  it('创建：默认 DRAFT、按组递增版本、内容哈希 64 位且随内容变化', async () => {
    const ctx = build();
    const v1 = await ctx.templates.create(tenant, emailTemplate);
    expect(v1).toMatchObject({ state: 'DRAFT', version: 1, jurisdiction: 'DE' });
    expect(v1.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const v2 = await ctx.templates.create(tenant, { ...emailTemplate, body: 'Neu, ...' });
    expect(v2.version).toBe(2);
    expect(v2.contentHash).not.toBe(v1.contentHash);

    const en = await ctx.templates.create(tenant, { ...emailTemplate, language: 'en' });
    expect(en.version).toBe(1);
  });

  it('负向：邮件模板必须带 subject；非法 kind/language 拒绝', async () => {
    const ctx = build();
    await expect(
      ctx.templates.create(tenant, { ...emailTemplate, subject: undefined }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');
    await expect(
      ctx.templates.create(tenant, { ...emailTemplate, kind: 'sms' as never }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');
    await expect(
      ctx.templates.create(tenant, { ...emailTemplate, language: 'DE' }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');
  });

  it('全生命周期：DRAFT→LEGAL_REVIEW→APPROVED→ACTIVE（旧 ACTIVE 自动退役）→RETIRED', async () => {
    const ctx = build();
    const v1 = await ctx.templates.create(tenant, emailTemplate);
    await ctx.templates.submitReview(tenant, v1.id);
    const review = await approvedReviewFor(ctx, v1.contentHash as string);
    const approved = await ctx.templates.approve(tenant, v1.id, review.id);
    expect(approved).toMatchObject({ state: 'APPROVED', legalReviewId: review.id });
    const active = await ctx.templates.activate(tenant, v1.id);
    expect(active.state).toBe('ACTIVE');
    expect(await ctx.templates.activeFor(tenant, 'email_first', 'DE', 'de')).toMatchObject({
      id: v1.id,
    });

    // 新版发布时旧 ACTIVE 自动退役。
    const v2 = await ctx.templates.create(tenant, { ...emailTemplate, body: 'Neu, ...' });
    await ctx.templates.submitReview(tenant, v2.id);
    const review2 = await approvedReviewFor(ctx, v2.contentHash as string);
    await ctx.templates.approve(tenant, v2.id, review2.id);
    await ctx.templates.activate(tenant, v2.id);
    expect(ctx.prisma.templates.find((row) => row.id === v1.id)!.state).toBe('RETIRED');
    expect(await ctx.templates.activeFor(tenant, 'email_first', 'DE', 'de')).toMatchObject({
      id: v2.id,
    });

    const retired = await ctx.templates.retire(tenant, v2.id);
    expect(retired.state).toBe('RETIRED');
    expect(await ctx.templates.activeFor(tenant, 'email_first', 'DE', 'de')).toBeNull();
  });

  it('负向：跳步/法审不匹配全部拒绝（状态、缺失、类型、结论、哈希）', async () => {
    const ctx = build();
    const v1 = await ctx.templates.create(tenant, emailTemplate);

    // 未提交法审就批准。
    await expect(
      ctx.templates.approve(tenant, v1.id, '99999999-9999-4999-8999-999999999999'),
    ).rejects.toSatisfy((error) => errorCode(error) === 'OUTREACH_TEMPLATE_STATE_INVALID');

    await ctx.templates.submitReview(tenant, v1.id);
    // 法审记录不存在。
    await expect(
      ctx.templates.approve(tenant, v1.id, '99999999-9999-4999-8999-999999999999'),
    ).rejects.toSatisfy((error) => errorCode(error) === 'OUTREACH_LEGAL_REVIEW_NOT_FOUND');
    // 类型不匹配。
    const phoneReview = await approvedReviewFor(ctx, v1.contentHash as string, {
      subjectKind: 'phone_script',
    });
    await expect(
      ctx.templates.approve(tenant, v1.id, phoneReview.id),
    ).rejects.toSatisfy((error) => errorCode(error) === 'OUTREACH_LEGAL_REVIEW_KIND_MISMATCH');
    // 结论不是 APPROVED。
    const conditionsReview = await approvedReviewFor(ctx, v1.contentHash as string, {
      verdict: 'CONDITIONS',
    });
    await expect(
      ctx.templates.approve(tenant, v1.id, conditionsReview.id),
    ).rejects.toSatisfy((error) => errorCode(error) === 'OUTREACH_LEGAL_REVIEW_NOT_APPROVED');
    // 哈希不一致（模板改过）。
    const staleReview = await approvedReviewFor(ctx, 'f'.repeat(64));
    await expect(
      ctx.templates.approve(tenant, v1.id, staleReview.id),
    ).rejects.toSatisfy((error) => errorCode(error) === 'OUTREACH_TEMPLATE_REVIEW_MISMATCH');
    // 未批准就激活。
    await expect(ctx.templates.activate(tenant, v1.id)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_TEMPLATE_STATE_INVALID',
    );
    // 重复提交法审。
    const review = await approvedReviewFor(ctx, v1.contentHash as string);
    await ctx.templates.approve(tenant, v1.id, review.id);
    await expect(ctx.templates.submitReview(tenant, v1.id)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_TEMPLATE_STATE_INVALID',
    );
    // DRAFT 不能退役。
    const v2 = await ctx.templates.create(tenant, { ...emailTemplate, body: 'x' });
    await expect(ctx.templates.retire(tenant, v2.id)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_TEMPLATE_STATE_INVALID',
    );
  });

  it('法审记录：校验 verdict/hash；按类型过滤；跨租户不可见', async () => {
    const ctx = build();
    await expect(
      ctx.reviews.create(tenant, {
        subjectKind: 'email_template',
        documentHash: 'xyz',
        reviewerName: 'A',
        reviewerFirm: 'B',
        reviewedAt: '2026-11-10T00:00:00Z',
        scope: 's',
        verdict: 'APPROVED',
        documentRef: 'ref',
      }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');
    await expect(
      ctx.reviews.create(tenant, {
        subjectKind: 'email_template',
        documentHash: 'a'.repeat(64),
        reviewerName: 'A',
        reviewerFirm: 'B',
        reviewedAt: '2026-11-10T00:00:00Z',
        scope: 's',
        verdict: 'MAYBE' as never,
        documentRef: 'ref',
      }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');

    const review = await approvedReviewFor(ctx, 'a'.repeat(64));
    const list = await ctx.reviews.list(tenant, 'email_template');
    expect(list).toHaveLength(1);
    expect(await ctx.reviews.list(tenant, 'phone_script')).toHaveLength(0);

    const v1 = await ctx.templates.create(tenant, emailTemplate);
    await expect(
      ctx.templates.get({ ...tenant, workspaceId: WS_B }, v1.id),
    ).rejects.toSatisfy((error) => errorCode(error) === 'OUTREACH_TEMPLATE_NOT_FOUND');
    expect(review.id).toBeTruthy();
  });
});

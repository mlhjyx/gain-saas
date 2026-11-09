import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { AuditService } from '../shared/audit.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import { OutreachCallsService } from './outreach-calls.service.js';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONTACT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SCRIPT = '99999999-9999-4999-8999-999999999999';
const REVIEW = '88888888-8888-4888-8888-888888888888';
const tenant: OutreachTenant = { userId: 'user-a', workspaceId: WS, role: 'admin' };

interface Row {
  [key: string]: unknown;
}

class FakeCallsPrisma {
  scripts: Row[] = [];
  reviews: Row[] = [];
  basis: Row[] = [];
  attempts: Row[] = [];
  consents: Row[] = [];
  seq = 0;

  private id(): string {
    return `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`;
  }

  readonly outreachTemplateVersion = {
    findFirst: async ({ where }: { where: Row }) =>
      this.scripts.find(
        (row) =>
          (!where.id || row.id === where.id) &&
          (!where.workspaceId || row.workspaceId === where.workspaceId),
      ) ?? null,
  };
  readonly legalReview = {
    findFirst: async ({ where }: { where: Row }) =>
      this.reviews.find(
        (row) =>
          (!where.id || row.id === where.id) &&
          (!where.workspaceId || row.workspaceId === where.workspaceId),
      ) ?? null,
  };
  readonly outreachCallBasis = {
    create: async ({ data }: { data: Row }) => {
      const row = { id: this.id(), createdAt: new Date(), ...data };
      this.basis.push(row);
      return { ...row };
    },
    findFirst: async ({ where }: { where: Row }) =>
      this.basis.find(
        (row) =>
          (!where.id || row.id === where.id) &&
          (!where.workspaceId || row.workspaceId === where.workspaceId),
      ) ?? null,
    findMany: async ({ where }: { where: Row }) =>
      this.basis.filter(
        (row) =>
          row.workspaceId === where.workspaceId &&
          (!where.contactRef || row.contactRef === where.contactRef),
      ),
  };
  readonly outreachCallAttempt = {
    create: async ({ data }: { data: Row }) => {
      const row = { id: this.id(), createdAt: new Date(), ...data };
      this.attempts.push(row);
      return { ...row };
    },
    findFirst: async ({ where, orderBy }: { where: Row; orderBy?: Row }) => {
      const rows = this.attempts.filter(
        (row) => row.basisId === where.basisId && row.workspaceId === where.workspaceId,
      );
      if (orderBy?.attemptNo === 'desc') {
        rows.sort((a, b) => (b.attemptNo as number) - (a.attemptNo as number));
      }
      return rows[0] ?? null;
    },
    findMany: async ({ where }: { where: Row }) =>
      this.attempts.filter(
        (row) => row.basisId === where.basisId && row.workspaceId === where.workspaceId,
      ),
  };
  readonly outreachConsent = {
    findFirst: async ({ where }: { where: Row }) =>
      this.consents.find(
        (row) =>
          row.workspaceId === where.workspaceId &&
          row.contactRef === where.contactRef &&
          (!where.channel || row.channel === where.channel) &&
          (!where.status || row.status === where.status),
      ) ?? null,
    create: async ({ data }: { data: Row }) => {
      const row = { id: this.id(), createdAt: new Date(), ...data };
      this.consents.push(row);
      return { ...row };
    },
  };
}

function seedPrereqs(prisma: FakeCallsPrisma) {
  prisma.scripts.push({
    id: SCRIPT,
    workspaceId: WS,
    kind: 'phone_script',
    state: 'ACTIVE',
    contentHash: 'a'.repeat(64),
  });
  prisma.reviews.push({
    id: REVIEW,
    workspaceId: WS,
    subjectKind: 'phone_script',
    verdict: 'APPROVED',
    documentHash: 'a'.repeat(64),
  });
}

function build(overrides: Partial<AppConfig> = {}) {
  const prisma = new FakeCallsPrisma();
  seedPrereqs(prisma);
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  const config = { OUTREACH_LEGAL_REQUIRE_COUNSEL: false, ...overrides } as AppConfig;
  return {
    prisma,
    service: new OutreachCallsService(prisma as unknown as PrismaService, audit, config),
  };
}

function errorCode(error: unknown): string {
  return (error as { response?: { error?: { code?: string } } }).response?.error?.code ?? '';
}

const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString();

function basisInput(overrides: Row = {}) {
  return {
    contactRef: CONTACT,
    phoneE164: '+493012345678',
    companyName: 'Beispiel GmbH',
    contactRole: 'Einkauf',
    triggerType: 'fair_visit',
    triggerEvidence: { fair: 'Messe X', booth: 'Halle 4 / B12', capturedAt: YESTERDAY },
    relevanceStatement: '对方在展会询问泵体交期缩短方案，与我方产品直接相关。',
    collectedSourceUrl: 'https://fair.example/booth-b12',
    collectedAt: YESTERDAY,
    scriptTemplateId: SCRIPT,
    legalReviewId: REVIEW,
    reviewedBy: 'ops-lead',
    reviewedAt: YESTERDAY,
    ...overrides,
  };
}

describe('OutreachCallsService（P4-10 电话证据链）', () => {
  it('建 basis：四问齐备时入库，validUntil 默认 = 采集日 + 90 天', async () => {
    const { prisma, service } = build();
    const row = await service.createBasis(tenant, basisInput());
    expect(row).toMatchObject({
      contactRef: CONTACT,
      phoneE164: '+493012345678',
      triggerType: 'fair_visit',
    });
    const validUntil = new Date(row.validUntil as Date).getTime();
    const expected = new Date(row.collectedAt as Date).getTime() + 90 * 86_400_000;
    expect(Math.abs(validUntil - expected)).toBeLessThan(86_400_000);
    expect(prisma.basis).toHaveLength(1);
  });

  it('负向：电话格式/关联陈述过短/证据为空/未来采集日/有效期超 90 天', async () => {
    const { service } = build();
    await expect(
      service.createBasis(tenant, basisInput({ phoneE164: '030-123' })),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');
    await expect(
      service.createBasis(tenant, basisInput({ relevanceStatement: '行业相关' })),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');
    await expect(
      service.createBasis(tenant, basisInput({ triggerEvidence: {} })),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');
    await expect(
      service.createBasis(
        tenant,
        basisInput({ collectedAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }),
      ),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');
    await expect(
      service.createBasis(
        tenant,
        basisInput({
          validUntil: new Date(Date.now() + 120 * 86_400_000).toISOString(),
        }),
      ),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');
  });

  it('负责人风险接受（OWNER_RISK_ACCEPTANCE）：默认可建依据；REQUIRE_COUNSEL=true 时拒绝', async () => {
    const owner = build();
    owner.prisma.reviews[0].reviewerKind = 'OWNER_RISK_ACCEPTANCE';
    const row = await owner.service.createBasis(tenant, basisInput());
    expect(row.id).toBeTruthy();

    const strict = build({ OUTREACH_LEGAL_REQUIRE_COUNSEL: true });
    strict.prisma.reviews[0].reviewerKind = 'OWNER_RISK_ACCEPTANCE';
    await expect(strict.service.createBasis(tenant, basisInput())).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_LEGAL_COUNSEL_REQUIRED',
    );
    // 律师意见在严格模式下仍然可用。
    strict.prisma.reviews[0].reviewerKind = 'LAWYER';
    await expect(strict.service.createBasis(tenant, basisInput())).resolves.toMatchObject({
      contactRef: CONTACT,
    });
  });

  it('负向：话术未 ACTIVE / 法审未 APPROVED 时拒绝（fail-closed）', async () => {
    const noScript = build();
    noScript.prisma.scripts[0].state = 'DRAFT';
    await expect(noScript.service.createBasis(tenant, basisInput())).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_CALL_SCRIPT_NOT_APPROVED',
    );

    const noReview = build();
    noReview.prisma.reviews[0].verdict = 'CONDITIONS';
    await expect(noReview.service.createBasis(tenant, basisInput())).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_CALL_LEGAL_REVIEW_REQUIRED',
    );
  });

  it('拨号记录：attemptNo 递增；basis 过期拒绝；跨租户 404', async () => {
    const { service } = build();
    const basis = await service.createBasis(tenant, basisInput());
    const first = await service.createAttempt(tenant, basis.id as string, {
      outcome: 'NO_ANSWER',
    });
    const second = await service.createAttempt(tenant, basis.id as string, {
      outcome: 'GATEKEEPER',
      durationSeconds: 30,
    });
    expect(first.attemptNo).toBe(1);
    expect(second.attemptNo).toBe(2);

    await expect(
      service.createAttempt({ ...tenant, workspaceId: WS_B }, basis.id as string, {
        outcome: 'NO_ANSWER',
      }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'OUTREACH_CALL_BASIS_NOT_FOUND');

    const expired = build();
    const expiredBasis = await expired.service.createBasis(tenant, basisInput());
    // 建单门保证 validUntil 未来；直接改库模拟「basis 建好后过期」，验证拨号前的有效期复查。
    expired.prisma.basis[0].validUntil = new Date(Date.now() - 86_400_000);
    await expect(
      expired.service.createAttempt(tenant, expiredBasis.id as string, { outcome: 'NO_ANSWER' }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'OUTREACH_CALL_BASIS_EXPIRED');
  });

  it('OBJECTED / nie_anrufen：写 phone 渠道 OPT_OUT，后续拨号被拒', async () => {
    const { prisma, service } = build();
    const basis = await service.createBasis(tenant, basisInput());
    await service.createAttempt(tenant, basis.id as string, {
      outcome: 'OBJECTED',
      objectionCode: 'kein_interesse',
      durationSeconds: 45,
    });
    expect(prisma.consents[0]).toMatchObject({
      channel: 'phone',
      status: 'OPT_OUT',
      source: 'call:objected',
    });
    await expect(
      service.createAttempt(tenant, basis.id as string, { outcome: 'NO_ANSWER' }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'OUTREACH_CALL_OBJECTED');

    // nie_anrufen 即使 outcome 不是 OBJECTED 也压制。
    const second = build();
    const basis2 = await second.service.createBasis(tenant, basisInput());
    await second.service.createAttempt(tenant, basis2.id as string, {
      outcome: 'CONNECTED_NO',
      objectionCode: 'nie_anrufen',
    });
    expect(second.prisma.consents[0]).toMatchObject({ channel: 'phone', status: 'OPT_OUT' });
  });

  it('WRONG_NUMBER / 普通结果不写压制；outcome 白名单校验', async () => {
    const { prisma, service } = build();
    const basis = await service.createBasis(tenant, basisInput());
    await service.createAttempt(tenant, basis.id as string, { outcome: 'WRONG_NUMBER' });
    expect(prisma.consents).toHaveLength(0);
    await expect(
      service.createAttempt(tenant, basis.id as string, { outcome: 'MAYBE' as never }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');
  });
});

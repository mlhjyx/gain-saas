import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const E164_RE = /^\+[1-9]\d{6,14}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

export const CALL_TRIGGER_TYPES = [
  'fair_visit',
  'inbound_inquiry',
  'existing_customer',
  'published_buying_role',
  'association_member',
  'referral',
  'public_procurement',
] as const;
export const CALL_OUTCOMES = [
  'CONNECTED_MEETING',
  'CONNECTED_FOLLOWUP',
  'CONNECTED_NO',
  'NO_ANSWER',
  'VOICEMAIL',
  'OBJECTED',
  'WRONG_NUMBER',
  'GATEKEEPER',
] as const;
export const CALL_OBJECTION_CODES = [
  'kein_interesse',
  'keine_zeit',
  'haben_schon',
  'datenschutz',
  'nie_anrufen',
] as const;

const MAX_BASIS_VALID_DAYS = 90;

export interface CallBasisInput {
  contactRef: unknown;
  phoneE164: unknown;
  companyName: unknown;
  contactRole?: unknown;
  triggerType: unknown;
  triggerEvidence: unknown;
  relevanceStatement: unknown;
  collectedSourceUrl: unknown;
  collectedAt: unknown;
  validUntil?: unknown;
  scriptTemplateId: unknown;
  legalReviewId: unknown;
  reviewedBy: unknown;
  reviewedAt: unknown;
}

export interface CallAttemptInput {
  startedAt?: unknown;
  endedAt?: unknown;
  durationSeconds?: unknown;
  outcome: unknown;
  objectionCode?: unknown;
  notesHash?: unknown;
  notesRef?: unknown;
}

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}
function notFound(): never {
  throw new NotFoundException({
    error: { code: 'OUTREACH_CALL_BASIS_NOT_FOUND', message: '拨号依据不存在' },
  });
}
function dayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * DE 电话推定同意证据链（P4-10，ch05 §5.3.4.2）。四问缺一不许建 basis：
 * 为什么打（trigger + evidence）／与产品有何具体关联（relevanceStatement，禁模板化）／
 * 证据来源与时间（collectedSourceUrl + collectedAt）／谁审过（scriptTemplate ACTIVE + legalReview APPROVED + reviewedBy/At）。
 * 拨号前复查 basis 有效期与 phone 渠道 OPT_OUT；OBJECTED/nie_anrufen 立即写 phone OPT_OUT 并阻断后续拨号。
 * 话术文本与律师意见为外部素材：模板/法审未就绪时本服务的门会 fail-closed。
 */
@Injectable()
export class OutreachCallsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async createBasis(tenant: OutreachTenant, input: CallBasisInput) {
    if (typeof input.contactRef !== 'string' || !UUID_RE.test(input.contactRef)) {
      invalid('contactRef must be a UUID');
    }
    const phoneE164 = typeof input.phoneE164 === 'string' ? input.phoneE164.trim() : '';
    if (!E164_RE.test(phoneE164)) invalid('phoneE164 必须是 E.164（+49…）');
    const companyName = typeof input.companyName === 'string' ? input.companyName.trim() : '';
    if (!companyName || companyName.length > 200) invalid('companyName 必填且不超过 200 字');
    const contactRole =
      typeof input.contactRole === 'string' ? input.contactRole.trim().slice(0, 200) : null;
    const triggerType = typeof input.triggerType === 'string' ? input.triggerType : '';
    if (!(CALL_TRIGGER_TYPES as readonly string[]).includes(triggerType)) {
      invalid(`triggerType 必须是 ${CALL_TRIGGER_TYPES.join('/')}`);
    }
    if (
      input.triggerEvidence === null ||
      typeof input.triggerEvidence !== 'object' ||
      Array.isArray(input.triggerEvidence) ||
      Object.keys(input.triggerEvidence as Row).length === 0
    ) {
      invalid('triggerEvidence 必须是非空对象（url/capturedAt/booth/formSubmissionId 等）');
    }
    const relevanceStatement =
      typeof input.relevanceStatement === 'string' ? input.relevanceStatement.trim() : '';
    if (relevanceStatement.length < 20 || relevanceStatement.length > 2000) {
      invalid('relevanceStatement 必须逐条手写（20–2000 字），不能用模板句');
    }
    const collectedSourceUrl =
      typeof input.collectedSourceUrl === 'string' ? input.collectedSourceUrl.trim() : '';
    if (!/^https?:\/\/\S+$/.test(collectedSourceUrl) || collectedSourceUrl.length > 2048) {
      invalid('collectedSourceUrl 必须是 http(s) URL');
    }
    const collectedAt = new Date(String(input.collectedAt));
    if (Number.isNaN(collectedAt.getTime())) invalid('collectedAt 不是合法日期');
    if (dayStart(collectedAt).getTime() > dayStart(new Date()).getTime()) {
      invalid('collectedAt 不能在未来');
    }
    const maxValid = new Date(collectedAt.getTime() + MAX_BASIS_VALID_DAYS * 86_400_000);
    const validUntil =
      input.validUntil === undefined || input.validUntil === null
        ? maxValid
        : new Date(String(input.validUntil));
    if (Number.isNaN(validUntil.getTime())) invalid('validUntil 不是合法日期');
    if (validUntil.getTime() > maxValid.getTime()) {
      invalid(`validUntil 不能超过采集日 + ${MAX_BASIS_VALID_DAYS} 天`);
    }
    if (dayStart(validUntil).getTime() < dayStart(new Date()).getTime()) {
      invalid('validUntil 已过期，请重新采集证据');
    }

    if (typeof input.scriptTemplateId !== 'string' || !UUID_RE.test(input.scriptTemplateId)) {
      invalid('scriptTemplateId must be a UUID');
    }
    const script = await this.prisma.outreachTemplateVersion.findFirst({
      where: { id: input.scriptTemplateId, workspaceId: tenant.workspaceId },
    });
    if (!script || script.kind !== 'phone_script' || script.state !== 'ACTIVE') {
      throw new ConflictException({
        error: {
          code: 'OUTREACH_CALL_SCRIPT_NOT_APPROVED',
          message: '拨号话术必须是已激活（ACTIVE）的 phone_script 模板版本（需先过法审）',
        },
      });
    }
    if (typeof input.legalReviewId !== 'string' || !UUID_RE.test(input.legalReviewId)) {
      invalid('legalReviewId must be a UUID');
    }
    const review = await this.prisma.legalReview.findFirst({
      where: { id: input.legalReviewId, workspaceId: tenant.workspaceId },
    });
    if (!review || review.subjectKind !== 'phone_script' || review.verdict !== 'APPROVED') {
      throw new ConflictException({
        error: {
          code: 'OUTREACH_CALL_LEGAL_REVIEW_REQUIRED',
          message: '拨号依据必须引用 APPROVED 的 phone_script 书面意见（律师意见或负责人风险接受记录）',
        },
      });
    }
    if (this.config.OUTREACH_LEGAL_REQUIRE_COUNSEL && review.reviewerKind !== 'LAWYER') {
      throw new ConflictException({
        error: {
          code: 'OUTREACH_LEGAL_COUNSEL_REQUIRED',
          message: '当前要求外部律师书面意见（OUTREACH_LEGAL_REQUIRE_COUNSEL=true），负责人风险接受记录不可用于拨号依据',
        },
      });
    }
    const reviewedBy = typeof input.reviewedBy === 'string' ? input.reviewedBy.trim() : '';
    if (!reviewedBy || reviewedBy.length > 200) invalid('reviewedBy 必填且不超过 200 字');
    const reviewedAt = new Date(String(input.reviewedAt));
    if (Number.isNaN(reviewedAt.getTime())) invalid('reviewedAt 不是合法时间');

    const row = await this.prisma.outreachCallBasis.create({
      data: {
        workspaceId: tenant.workspaceId,
        contactRef: input.contactRef,
        phoneE164,
        companyName,
        contactRole,
        triggerType,
        triggerEvidence: input.triggerEvidence as Prisma.InputJsonValue,
        relevanceStatement,
        collectedSourceUrl,
        collectedAt,
        scriptTemplateId: input.scriptTemplateId,
        legalReviewId: input.legalReviewId,
        reviewedBy,
        reviewedAt,
        validUntil,
        createdBy: tenant.userId,
      },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.call_basis.created',
      target: row.id,
      detail: { triggerType, scriptTemplateId: input.scriptTemplateId, validUntil: validUntil.toISOString() },
    });
    return row;
  }

  async listBasis(tenant: OutreachTenant, contactRef?: string) {
    if (contactRef !== undefined && !UUID_RE.test(contactRef)) invalid('contactRef must be a UUID');
    return this.prisma.outreachCallBasis.findMany({
      where: {
        workspaceId: tenant.workspaceId,
        ...(contactRef ? { contactRef } : {}),
      },
      orderBy: [{ collectedAt: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
  }

  async getBasis(tenant: OutreachTenant, basisId: string) {
    return this.requireBasis(tenant, basisId);
  }

  async listAttempts(tenant: OutreachTenant, basisId: string) {
    await this.requireBasis(tenant, basisId);
    return this.prisma.outreachCallAttempt.findMany({
      where: { basisId, workspaceId: tenant.workspaceId },
      orderBy: { attemptNo: 'asc' },
    });
  }

  async createAttempt(tenant: OutreachTenant, basisId: string, input: CallAttemptInput) {
    const basis = await this.requireBasis(tenant, basisId);
    if (dayStart(basis.validUntil).getTime() < dayStart(new Date()).getTime()) {
      throw new ConflictException({
        error: {
          code: 'OUTREACH_CALL_BASIS_EXPIRED',
          message: '拨号依据已过期（validUntil），请重新采集证据后再拨号',
        },
      });
    }
    const phoneOptOut = await this.prisma.outreachConsent.findFirst({
      where: {
        workspaceId: tenant.workspaceId,
        contactRef: basis.contactRef,
        channel: 'phone',
        status: 'OPT_OUT',
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (phoneOptOut) {
      throw new ConflictException({
        error: {
          code: 'OUTREACH_CALL_OBJECTED',
          message: '该联系人已在电话渠道明确反对联系（OPT_OUT），不得再拨号',
        },
      });
    }

    const outcome = typeof input.outcome === 'string' ? input.outcome : '';
    if (!(CALL_OUTCOMES as readonly string[]).includes(outcome)) {
      invalid(`outcome 必须是 ${CALL_OUTCOMES.join('/')}`);
    }
    const objectionCode =
      typeof input.objectionCode === 'string' ? input.objectionCode : null;
    if (objectionCode !== null && !(CALL_OBJECTION_CODES as readonly string[]).includes(objectionCode)) {
      invalid(`objectionCode 必须是 ${CALL_OBJECTION_CODES.join('/')}`);
    }
    const startedAt =
      input.startedAt === undefined ? new Date() : new Date(String(input.startedAt));
    if (Number.isNaN(startedAt.getTime())) invalid('startedAt 不是合法时间');
    const endedAt =
      input.endedAt === undefined ? null : new Date(String(input.endedAt));
    if (endedAt && (Number.isNaN(endedAt.getTime()) || endedAt.getTime() < startedAt.getTime())) {
      invalid('endedAt 必须晚于 startedAt');
    }
    let durationSeconds: number | null = null;
    if (input.durationSeconds !== undefined && input.durationSeconds !== null) {
      const parsed = Number(input.durationSeconds);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 7200) {
        invalid('durationSeconds 必须是 0..7200 的整数');
      }
      durationSeconds = parsed;
    }
    let notesHash: string | null = null;
    if (input.notesHash !== undefined && input.notesHash !== null) {
      if (typeof input.notesHash !== 'string' || !HASH_RE.test(input.notesHash)) {
        invalid('notesHash 必须是 64 位十六进制');
      }
      notesHash = input.notesHash;
    }
    const notesRef =
      typeof input.notesRef === 'string' ? input.notesRef.trim().slice(0, 256) : null;

    const last = await this.prisma.outreachCallAttempt.findFirst({
      where: { basisId, workspaceId: tenant.workspaceId },
      orderBy: { attemptNo: 'desc' },
      select: { attemptNo: true },
    });
    const attemptNo = (last?.attemptNo ?? 0) + 1;
    let attempt;
    try {
      attempt = await this.prisma.outreachCallAttempt.create({
        data: {
          workspaceId: tenant.workspaceId,
          basisId,
          attemptNo,
          startedAt,
          endedAt,
          durationSeconds,
          outcome,
          objectionCode,
          notesHash,
          notesRef,
          createdBy: tenant.userId,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({
          error: {
            code: 'OUTREACH_CALL_ATTEMPT_CONFLICT',
            message: '拨号序号冲突，请重试',
          },
        });
      }
      throw error;
    }

    if (outcome === 'OBJECTED' || objectionCode === 'nie_anrufen') {
      await this.prisma.outreachConsent.create({
        data: {
          workspaceId: tenant.workspaceId,
          contactRef: basis.contactRef,
          channel: 'phone',
          status: 'OPT_OUT',
          source: 'call:objected',
          lawfulBasis: 'consent_withdrawal',
          evidence: {
            basisId,
            attemptId: attempt.id,
            outcome,
            objectionCode,
          } as Prisma.InputJsonValue,
        },
      });
    }
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.call_attempt.recorded',
      target: attempt.id,
      detail: { basisId, outcome, objectionCode, attemptNo },
    });
    return attempt;
  }

  private async requireBasis(tenant: OutreachTenant, basisId: string) {
    if (!UUID_RE.test(basisId)) notFound();
    const basis = await this.prisma.outreachCallBasis.findFirst({
      where: { id: basisId, workspaceId: tenant.workspaceId },
    });
    if (!basis) notFound();
    return basis;
  }
}

interface Row {
  [key: string]: unknown;
}

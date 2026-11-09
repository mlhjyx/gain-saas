import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const SUBJECT_KINDS = ['email_template', 'phone_script', 'consent_wording', 'lia_letter'] as const;
const VERDICTS = ['APPROVED', 'CONDITIONS', 'REJECTED'] as const;

export interface LegalReviewInput {
  subjectKind: unknown;
  documentHash: unknown;
  reviewerName: unknown;
  reviewerFirm: unknown;
  reviewedAt: unknown;
  scope: unknown;
  verdict: unknown;
  conditions?: unknown;
  documentRef: unknown;
}

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

/**
 * 法审记录（P4-05 占位）：律师书面意见入库，供模板版本/话术/同意措辞引用。
 * 只有 verdict=APPROVED 的记录允许被模板激活（D5-11 发布门）；CONDITIONS 视为未通过，需按意见修改后重审。
 */
@Injectable()
export class OutreachLegalReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(tenant: OutreachTenant, input: LegalReviewInput) {
    const subjectKind = typeof input.subjectKind === 'string' ? input.subjectKind : '';
    if (!(SUBJECT_KINDS as readonly string[]).includes(subjectKind)) {
      invalid('subjectKind 必须是 email_template/phone_script/consent_wording/lia_letter');
    }
    const documentHash =
      typeof input.documentHash === 'string' ? input.documentHash.trim().toLowerCase() : '';
    if (!HASH_RE.test(documentHash)) invalid('documentHash 必须是 64 位十六进制');
    const reviewerName =
      typeof input.reviewerName === 'string' ? input.reviewerName.trim() : '';
    if (!reviewerName || reviewerName.length > 200) invalid('reviewerName 必填且不超过 200 字');
    const reviewerFirm =
      typeof input.reviewerFirm === 'string' ? input.reviewerFirm.trim() : '';
    if (!reviewerFirm || reviewerFirm.length > 200) invalid('reviewerFirm 必填且不超过 200 字');
    const reviewedAt = new Date(String(input.reviewedAt));
    if (Number.isNaN(reviewedAt.getTime())) invalid('reviewedAt 不是合法日期');
    const scope = typeof input.scope === 'string' ? input.scope.trim() : '';
    if (!scope || scope.length > 500) invalid('scope 必填且不超过 500 字');
    const verdict = typeof input.verdict === 'string' ? input.verdict : '';
    if (!(VERDICTS as readonly string[]).includes(verdict)) {
      invalid('verdict 必须是 APPROVED/CONDITIONS/REJECTED');
    }
    const conditions =
      typeof input.conditions === 'string' ? input.conditions.trim().slice(0, 5000) : null;
    const documentRef =
      typeof input.documentRef === 'string' ? input.documentRef.trim() : '';
    if (!documentRef || documentRef.length > 256) invalid('documentRef 必填且不超过 256 字');

    const row = await this.prisma.legalReview.create({
      data: {
        workspaceId: tenant.workspaceId,
        subjectKind,
        documentHash,
        reviewerName,
        reviewerFirm,
        reviewedAt,
        scope,
        verdict,
        conditions,
        documentRef,
        createdBy: tenant.userId,
      },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.legal_review.recorded',
      target: row.id,
      detail: { subjectKind, verdict },
    });
    return row;
  }

  async list(tenant: OutreachTenant, subjectKind?: string) {
    return this.prisma.legalReview.findMany({
      where: {
        workspaceId: tenant.workspaceId,
        ...(subjectKind ? { subjectKind } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async get(tenant: OutreachTenant, reviewId: string) {
    if (!UUID_RE.test(reviewId)) notFound();
    const row = await this.prisma.legalReview.findFirst({
      where: { id: reviewId, workspaceId: tenant.workspaceId },
    });
    if (!row) notFound();
    return row;
  }
}

function notFound(): never {
  throw new NotFoundException({
    error: { code: 'OUTREACH_LEGAL_REVIEW_NOT_FOUND', message: '法审记录不存在' },
  });
}

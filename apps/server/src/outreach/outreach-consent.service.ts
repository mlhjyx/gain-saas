import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, OutreachConsentStatus } from '@prisma/client';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachDncChecker } from './outreach-dnc.checker.js';
import {
  evaluateConsentPolicy,
  type OutreachJurisdictionPolicy,
} from './outreach-jurisdiction.js';

export interface OutreachTenant {
  userId: string;
  workspaceId: string;
  role: 'admin' | 'member';
}

export const OUTREACH_DNC_CHECKER = Symbol('OUTREACH_DNC_CHECKER');

export type OutreachEligibility =
  | {
      allowed: true;
      jurisdictionPolicy: OutreachJurisdictionPolicy;
      consentStatus: OutreachConsentStatus | 'MISSING';
    }
  | {
      allowed: false;
      code: string;
      message: string;
      jurisdictionPolicy: OutreachJurisdictionPolicy;
      consentStatus: OutreachConsentStatus | 'MISSING';
    };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid(code: string, message: string): never {
  throw new BadRequestException({ error: { code, message } });
}

/**
 * 外联同意/法域/DNC 的发送前合规检查（M2 步 11-1）。
 * 结论是数据而不是异常：调用方（11-3 审批/11-2 发送）必须按 allowed=false fail closed。
 */
@Injectable()
export class OutreachConsentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(OUTREACH_DNC_CHECKER) private readonly dnc: OutreachDncChecker,
  ) {}

  async record(
    tenant: OutreachTenant,
    input: {
      contactRef: string;
      status: OutreachConsentStatus;
      source: string;
      lawfulBasis: string;
      evidence?: unknown;
    },
  ) {
    if (!UUID_RE.test(input.contactRef)) {
      invalid('VALIDATION_ERROR', 'contactRef must be a UUID');
    }
    if (!Object.values(OutreachConsentStatus).includes(input.status)) {
      invalid('VALIDATION_ERROR', 'status must be OPT_IN, OPT_OUT or UNKNOWN');
    }
    const source = input.source?.trim();
    const lawfulBasis = input.lawfulBasis?.trim();
    if (!source || source.length > 64) {
      invalid('VALIDATION_ERROR', 'source must be 1..64 characters');
    }
    if (!lawfulBasis || lawfulBasis.length > 64) {
      invalid('VALIDATION_ERROR', 'lawfulBasis must be 1..64 characters');
    }
    const row = await this.prisma.outreachConsent.create({
      data: {
        workspaceId: tenant.workspaceId,
        contactRef: input.contactRef,
        channel: 'email',
        status: input.status,
        source,
        lawfulBasis,
        evidence: (input.evidence ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.consent.recorded',
      target: input.contactRef,
      detail: { status: input.status, source },
    });
    return row;
  }

  async latest(tenant: OutreachTenant, contactRef: string) {
    if (!UUID_RE.test(contactRef)) {
      invalid('VALIDATION_ERROR', 'contactRef must be a UUID');
    }
    return this.prisma.outreachConsent.findFirst({
      where: {
        workspaceId: tenant.workspaceId,
        contactRef,
        channel: 'email',
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  async getLatest(tenant: OutreachTenant, contactRef: string) {
    const row = await this.latest(tenant, contactRef);
    if (!row) {
      throw new NotFoundException({
        error: { code: 'OUTREACH_CONSENT_NOT_FOUND', message: '尚无同意记录' },
      });
    }
    return row;
  }

  async eligibility(
    tenant: OutreachTenant,
    input: { contactRef: string; countryCode: string; email: string },
  ): Promise<OutreachEligibility> {
    const consent = await this.latest(tenant, input.contactRef);
    const consentStatus = consent?.status ?? ('MISSING' as const);
    // 与发送门共用同一条法域同意判定梯（evaluateConsentPolicy），避免两份合规规则漂移。
    const policyDecision = evaluateConsentPolicy({
      countryCode: input.countryCode,
      consentStatus,
    });
    const jurisdictionPolicy = policyDecision.policy;
    if (!policyDecision.allowed) {
      return {
        allowed: false,
        code: policyDecision.code ?? 'JURISDICTION_REVIEW_REQUIRED',
        message: policyDecision.message ?? '该法域默认不发送',
        jurisdictionPolicy,
        consentStatus,
      };
    }
    if (!input.email || !input.email.includes('@')) {
      return {
        allowed: false,
        code: 'OUTREACH_DNC_EMAIL_REQUIRED',
        message: '缺少可检查的收件邮箱，无法通过 DNC 门',
        jurisdictionPolicy,
        consentStatus,
      };
    }
    const suppressed = await this.dnc.check(tenant, [input.email]);
    const reasons = suppressed.get(input.email.trim().toLowerCase()) ?? [];
    if (reasons.length > 0) {
      return {
        allowed: false,
        code: 'OUTREACH_DNC_BLOCKED',
        message: '收件邮箱在禁联名单或全局抑制中',
        jurisdictionPolicy,
        consentStatus,
      };
    }
    return { allowed: true, jurisdictionPolicy, consentStatus };
  }
}

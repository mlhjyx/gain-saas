import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import { hashJson } from './outreach-content.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEMPLATE_KINDS = [
  'email_first',
  'email_followup',
  'email_footer',
  'phone_script',
  'consent_wording',
] as const;
type TemplateKind = (typeof TEMPLATE_KINDS)[number];

const EMAIL_KINDS: ReadonlySet<TemplateKind> = new Set(['email_first', 'email_followup', 'email_footer']);

/** 模板类型 → 法审 subjectKind（激活时法审记录的类型必须匹配）。 */
export function reviewKindFor(kind: TemplateKind): string {
  if (EMAIL_KINDS.has(kind)) return 'email_template';
  if (kind === 'phone_script') return 'phone_script';
  return 'consent_wording';
}

export interface CreateTemplateInput {
  kind: unknown;
  jurisdiction?: unknown;
  language: unknown;
  subject?: unknown;
  body: unknown;
}

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}
function notFound(): never {
  throw new NotFoundException({
    error: { code: 'OUTREACH_TEMPLATE_NOT_FOUND', message: '模板版本不存在' },
  });
}
function stateConflict(state: string, expected: string): never {
  throw new ConflictException({
    error: {
      code: 'OUTREACH_TEMPLATE_STATE_INVALID',
      message: `模板状态为 ${state}，需要 ${expected}`,
    },
  });
}

/**
 * 模板版本化（P4-05）：每次修改 = 新版本；新版本默认 DRAFT（不生效），发送/序列链路只认 ACTIVE。
 * 生命周期：DRAFT →(提交法审)→ LEGAL_REVIEW →(绑定 APPROVED 且哈希一致的法审)→ APPROVED
 * →(激活，自动退役同组旧 ACTIVE)→ ACTIVE →(退役)→ RETIRED。
 * 法审文案与律师意见等外部素材；此处只做版本化、快照与法审占位（D5-11 发布门）。
 */
@Injectable()
export class OutreachTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(tenant: OutreachTenant, input: CreateTemplateInput) {
    const kind = typeof input.kind === 'string' ? input.kind : '';
    if (!(TEMPLATE_KINDS as readonly string[]).includes(kind)) {
      invalid(`kind 必须是 ${TEMPLATE_KINDS.join('/')}`);
    }
    const templateKind = kind as TemplateKind;
    const jurisdictionRaw =
      input.jurisdiction === undefined ? 'ALL' : String(input.jurisdiction).trim().toUpperCase();
    if (!/^([A-Z]{2}|ALL)$/.test(jurisdictionRaw)) {
      invalid('jurisdiction 必须是 ISO 3166-1 两位国家代码或 ALL');
    }
    const language = typeof input.language === 'string' ? input.language.trim() : '';
    if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(language)) invalid('language 必须是 en/fr/de 形态的语言代码');
    const subject =
      input.subject === undefined || input.subject === null
        ? null
        : typeof input.subject === 'string'
          ? input.subject.trim()
          : '';
    if (subject !== null && subject.length > 300) invalid('subject 不超过 300 字');
    if (EMAIL_KINDS.has(templateKind) && !subject) invalid('邮件模板必须提供 subject');
    const body = typeof input.body === 'string' ? input.body.trim() : '';
    if (!body || body.length > 20_000) invalid('body 必填且不超过 20000 字');

    const contentHash = hashJson({ kind: templateKind, jurisdiction: jurisdictionRaw, language, subject, body });
    const latest = await this.prisma.outreachTemplateVersion.findFirst({
      where: {
        workspaceId: tenant.workspaceId,
        kind: templateKind,
        jurisdiction: jurisdictionRaw,
        language,
      },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const row = await this.prisma.outreachTemplateVersion.create({
      data: {
        workspaceId: tenant.workspaceId,
        kind: templateKind,
        jurisdiction: jurisdictionRaw,
        language,
        version: (latest?.version ?? 0) + 1,
        subject,
        body,
        contentHash,
        state: 'DRAFT',
        createdBy: tenant.userId,
      },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.template.created',
      target: row.id,
      detail: { kind: templateKind, jurisdiction: jurisdictionRaw, language, version: row.version },
    });
    return row;
  }

  async list(tenant: OutreachTenant, filters: { kind?: string; state?: string } = {}) {
    return this.prisma.outreachTemplateVersion.findMany({
      where: {
        workspaceId: tenant.workspaceId,
        ...(filters.kind ? { kind: filters.kind } : {}),
        ...(filters.state ? { state: filters.state } : {}),
      },
      orderBy: [{ kind: 'asc' }, { jurisdiction: 'asc' }, { language: 'asc' }, { version: 'desc' }],
      take: 200,
    });
  }

  async get(tenant: OutreachTenant, templateId: string) {
    return this.requireTemplate(tenant, templateId);
  }

  async submitReview(tenant: OutreachTenant, templateId: string) {
    const template = await this.requireTemplate(tenant, templateId);
    if (template.state !== 'DRAFT') stateConflict(template.state, 'DRAFT');
    const updated = await this.prisma.outreachTemplateVersion.update({
      where: { id: templateId },
      data: { state: 'LEGAL_REVIEW' },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.template.submitted',
      target: templateId,
    });
    return updated;
  }

  /** 绑定法审：必须 APPROVED + subjectKind 匹配 + documentHash === template.contentHash。 */
  async approve(tenant: OutreachTenant, templateId: string, legalReviewId: unknown) {
    const template = await this.requireTemplate(tenant, templateId);
    if (template.state !== 'LEGAL_REVIEW') stateConflict(template.state, 'LEGAL_REVIEW');
    if (typeof legalReviewId !== 'string' || !UUID_RE.test(legalReviewId)) {
      invalid('legalReviewId must be a UUID');
    }
    const review = await this.prisma.legalReview.findFirst({
      where: { id: legalReviewId, workspaceId: tenant.workspaceId },
    });
    if (!review) {
      throw new NotFoundException({
        error: { code: 'OUTREACH_LEGAL_REVIEW_NOT_FOUND', message: '法审记录不存在' },
      });
    }
    if (review.subjectKind !== reviewKindFor(template.kind as TemplateKind)) {
      throw new ConflictException({
        error: {
          code: 'OUTREACH_LEGAL_REVIEW_KIND_MISMATCH',
          message: `法审类型 ${review.subjectKind} 与模板类型不匹配（需要 ${reviewKindFor(template.kind as TemplateKind)}）`,
        },
      });
    }
    if (review.verdict !== 'APPROVED') {
      throw new ConflictException({
        error: {
          code: 'OUTREACH_LEGAL_REVIEW_NOT_APPROVED',
          message: `法审结论为 ${review.verdict}，只有 APPROVED 可以激活模板`,
        },
      });
    }
    if (review.documentHash !== template.contentHash) {
      throw new ConflictException({
        error: {
          code: 'OUTREACH_TEMPLATE_REVIEW_MISMATCH',
          message: '法审文档哈希与当前模板内容不一致（模板改过），需重新提交法审',
        },
      });
    }
    if (this.config.OUTREACH_LEGAL_REQUIRE_COUNSEL && review.reviewerKind !== 'LAWYER') {
      throw new ConflictException({
        error: {
          code: 'OUTREACH_LEGAL_COUNSEL_REQUIRED',
          message: '当前要求外部律师书面意见（OUTREACH_LEGAL_REQUIRE_COUNSEL=true），负责人风险接受记录不可用于激活',
        },
      });
    }
    const updated = await this.prisma.outreachTemplateVersion.update({
      where: { id: templateId },
      data: { state: 'APPROVED', legalReviewId },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.template.approved',
      target: templateId,
      detail: { legalReviewId },
    });
    return updated;
  }

  /** 激活：APPROVED→ACTIVE，同组旧 ACTIVE 自动退役（同一时刻只有一版生效）。 */
  async activate(tenant: OutreachTenant, templateId: string) {
    const template = await this.requireTemplate(tenant, templateId);
    if (template.state !== 'APPROVED') stateConflict(template.state, 'APPROVED');
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.outreachTemplateVersion.updateMany({
        where: {
          workspaceId: tenant.workspaceId,
          kind: template.kind,
          jurisdiction: template.jurisdiction,
          language: template.language,
          state: 'ACTIVE',
          id: { not: templateId },
        },
        data: { state: 'RETIRED' },
      });
      return tx.outreachTemplateVersion.update({
        where: { id: templateId },
        data: { state: 'ACTIVE' },
      });
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.template.activated',
      target: templateId,
    });
    return updated;
  }

  async retire(tenant: OutreachTenant, templateId: string) {
    const template = await this.requireTemplate(tenant, templateId);
    if (template.state !== 'ACTIVE' && template.state !== 'APPROVED') {
      stateConflict(template.state, 'ACTIVE 或 APPROVED');
    }
    const updated = await this.prisma.outreachTemplateVersion.update({
      where: { id: templateId },
      data: { state: 'RETIRED' },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.template.retired',
      target: templateId,
    });
    return updated;
  }

  /** 未来序列/发送链路读活跃模板：同组唯一 ACTIVE，无则 null（fail-closed，不回落旧版）。 */
  async activeFor(
    tenant: OutreachTenant,
    kind: TemplateKind,
    jurisdiction: string,
    language: string,
  ) {
    return this.prisma.outreachTemplateVersion.findFirst({
      where: {
        workspaceId: tenant.workspaceId,
        kind,
        jurisdiction,
        language,
        state: 'ACTIVE',
      },
    });
  }

  private async requireTemplate(tenant: OutreachTenant, templateId: string) {
    if (!UUID_RE.test(templateId)) notFound();
    const template = await this.prisma.outreachTemplateVersion.findFirst({
      where: { id: templateId, workspaceId: tenant.workspaceId },
    });
    if (!template) notFound();
    return template;
  }
}

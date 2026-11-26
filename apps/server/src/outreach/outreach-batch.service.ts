import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { validateT1Attachments, type T1AttachmentRef } from '@gain-saas/shared';
import { OutreachAuthorizationIssuer } from '../campaign/outreach-authorization.issuer.js';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { AuditService } from '../shared/audit.service.js';
import { PiiCryptoService } from '../shared/pii-crypto.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import { hashOutreachDrafts } from './outreach-content.js';
import { OUTREACH_PII_PURPOSE } from './outreach-pii.constants.js';
import { sendJobKey } from './outreach-send-jobs.service.js';

function authorizationErrorCode(error: unknown): string {
  const code = (error as { response?: { error?: { code?: unknown } } })?.response?.error?.code;
  return typeof code === 'string' ? code : 'AUTHORIZATION_ISSUE_FAILED';
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function invalid(code: string, message: string): never {
  throw new BadRequestException({ error: { code, message } });
}
function notFound(): never {
  throw new NotFoundException({
    error: { code: 'OUTREACH_BATCH_NOT_FOUND', message: '触达批次不存在' },
  });
}
function conflict(code: string, message: string): never {
  throw new ConflictException({ error: { code, message } });
}

export interface OutreachDraftInput {
  contactRef: string;
  /** 引擎 contact_point id（email 通讯点）；退信回写寻址用，可空（legacy 兼容）。 */
  contactPointId?: string | null;
  recipientEmail: string;
  companyName?: string | null;
  subject: string;
  body: string;
  /** 收件人国家（ISO 3166-1 alpha-2）；发送时法域同意门的输入，缺失按 REVIEW_REQUIRED 拒发。 */
  countryCode?: string | null;
  /** Phase 3 T1：关联本公司已就绪（ready）PDF / HTML 卖家画册附件引用（零 schema 迁移，落事件明细）。 */
  attachments?: readonly T1AttachmentRef[];
}

function normalizeDraft(input: OutreachDraftInput) {
  if (!UUID_RE.test(input.contactRef)) {
    invalid('VALIDATION_ERROR', 'contactRef must be a UUID');
  }
  if (input.contactPointId !== undefined && input.contactPointId !== null && !UUID_RE.test(input.contactPointId)) {
    invalid('VALIDATION_ERROR', 'contactPointId must be a UUID');
  }
  const recipientEmail = input.recipientEmail.trim().toLowerCase();
  if (!EMAIL_RE.test(recipientEmail) || recipientEmail.length > 320) {
    invalid('VALIDATION_ERROR', '收件邮箱不合法');
  }
  const subject = input.subject.trim();
  if (!subject || subject.length > 300) {
    invalid('VALIDATION_ERROR', '主题必填且不超过 300 字');
  }
  const body = input.body.trim();
  if (!body || body.length > 20_000) {
    invalid('VALIDATION_ERROR', '正文必填且不超过 20000 字');
  }
  const companyName = input.companyName?.trim() || null;
  if (companyName && companyName.length > 200) {
    invalid('VALIDATION_ERROR', '公司名不超过 200 字');
  }
  const countryCode = input.countryCode?.trim().toUpperCase() || null;
  if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) {
    invalid('VALIDATION_ERROR', 'countryCode 必须是 ISO 3166-1 两位国家代码');
  }
  return {
    contactRef: input.contactRef,
    contactPointId: input.contactPointId?.trim() || null,
    recipientEmail,
    companyName,
    subject,
    body,
    countryCode,
  };
}

/**
 * 触达批次与草稿审批（M2 步 11-2）。
 * 语义复用 M2.0：审批单元=内容哈希、超时=拒绝、旧同意不可复用（提交后草稿冻结）、自审留痕。
 * 批准只把批次置为 QUEUED；发送开关与执行器在 11-3，默认不发。
 */
@Injectable()
export class OutreachBatchService {
  private readonly approvalTtlMs: number;
  private readonly maxRecipients: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly authorizationIssuer: OutreachAuthorizationIssuer,
    @Optional() private readonly crypto?: PiiCryptoService,
  ) {
    this.approvalTtlMs = config.OUTREACH_APPROVAL_TTL_HOURS * 3600_000;
    // 单批收件人上限（M2 D-11-d：≤50），建草稿与提交两个入口都拦。
    this.maxRecipients = config.OUTREACH_BATCH_MAX_RECIPIENTS ?? 50;
  }

  private encryptDraftEmail(workspaceId: string, email: string): string {
    if (!this.crypto) return email;
    return this.crypto.encryptField(
      workspaceId,
      email,
      OUTREACH_PII_PURPOSE.DRAFT_RECIPIENT_EMAIL,
    );
  }

  private decryptDraftEmail(workspaceId: string, stored: string): string {
    if (!this.crypto) return stored;
    return this.crypto.decryptField(
      workspaceId,
      stored,
      OUTREACH_PII_PURPOSE.DRAFT_RECIPIENT_EMAIL,
    );
  }

  private decryptDraft<T extends { recipientEmail: string }>(workspaceId: string, draft: T): T {
    if (!this.crypto) return draft;
    return {
      ...draft,
      recipientEmail: this.decryptDraftEmail(workspaceId, draft.recipientEmail),
    };
  }

  async createBatch(
    tenant: OutreachTenant,
    input: { name: unknown; campaignId?: unknown; mailboxId?: unknown },
  ) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 200) {
      invalid('VALIDATION_ERROR', '批次名称必填且不超过 200 字');
    }
    let campaignId: string | null = null;
    if (input.campaignId !== undefined && input.campaignId !== null) {
      if (typeof input.campaignId !== 'string' || !UUID_RE.test(input.campaignId)) {
        invalid('VALIDATION_ERROR', 'campaignId must be a UUID');
      }
      campaignId = input.campaignId;
    }
    let mailboxId: string | null = null;
    if (input.mailboxId !== undefined && input.mailboxId !== null) {
      if (typeof input.mailboxId !== 'string' || !UUID_RE.test(input.mailboxId)) {
        invalid('VALIDATION_ERROR', 'mailboxId must be a UUID');
      }
      mailboxId = input.mailboxId;
    }
    const batch = await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
      if (campaignId !== null) {
        const campaign = await tx.campaign.findFirst({
          where: { id: campaignId, workspaceId: tenant.workspaceId },
          select: { id: true },
        });
        if (!campaign) {
          throw new NotFoundException({
            error: { code: 'CAMPAIGN_NOT_FOUND', message: 'campaign 不存在' },
          });
        }
      }
      if (mailboxId !== null) {
        const mailbox = await tx.outreachMailbox.findFirst({
          where: { id: mailboxId, workspaceId: tenant.workspaceId },
          select: { id: true },
        });
        if (!mailbox) {
          throw new NotFoundException({
            error: { code: 'OUTREACH_MAILBOX_NOT_FOUND', message: '发件信箱不存在' },
          });
        }
      }
      return tx.outreachBatch.create({
        data: {
          workspaceId: tenant.workspaceId,
          campaignId,
          ...(mailboxId ? { mailboxId } : {}),
          name,
          createdBy: tenant.userId,
        },
      });
    });
    await this.event(tenant, batch.id, 'BATCH_CREATED', { name, ...(mailboxId ? { mailboxId } : {}) });
    return batch;
  }

  async listBatches(tenant: OutreachTenant) {
    await this.expireStaleBatches(tenant);
    const rows = await this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
      tx.outreachBatch.findMany({
        where: { workspaceId: tenant.workspaceId },
        orderBy: { updatedAt: 'desc' },
        include: {
          _count: { select: { drafts: true } },
          approvals: {
            where: { state: 'PENDING' },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      }),
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      campaignId: row.campaignId,
      draftCount: row._count.drafts,
      pendingApproval: row.approvals[0]
        ? { id: row.approvals[0].id, expiresAt: row.approvals[0].expiresAt }
        : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async getBatch(tenant: OutreachTenant, batchId: string) {
    if (!UUID_RE.test(batchId)) notFound();
    await this.expireBatchIfStale(tenant, batchId);
    const batch = await this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
      tx.outreachBatch.findFirst({
        where: { workspaceId: tenant.workspaceId, id: batchId },
        include: {
          drafts: { orderBy: { createdAt: 'asc' } },
          approvals: { orderBy: { createdAt: 'desc' } },
          events: { orderBy: { createdAt: 'asc' } },
        },
      }),
    );
    if (!batch) notFound();
    const decryptedBatch = {
      ...batch,
      drafts: batch.drafts.map((draft) => this.decryptDraft(tenant.workspaceId, draft)),
    };
    return this.attachDraftAttachments(decryptedBatch);
  }

  private attachDraftAttachments<
    T extends {
      drafts: Array<{ id: string }>;
      events: Array<{ type: string; detail: unknown }>;
    },
  >(batch: T): T & { drafts: Array<T['drafts'][number] & { attachments: T1AttachmentRef[] }> } {
    const byDraft = new Map<string, T1AttachmentRef[]>();
    for (const ev of batch.events ?? []) {
      if (ev.type !== 'DRAFT_ATTACHMENTS_SET' || !ev.detail || typeof ev.detail !== 'object') {
        continue;
      }
      const detail = ev.detail as Record<string, unknown>;
      const draftId = typeof detail.draftId === 'string' ? detail.draftId : '';
      if (!draftId || !Array.isArray(detail.attachments)) continue;
      byDraft.set(draftId, detail.attachments as T1AttachmentRef[]);
    }
    return {
      ...batch,
      drafts: batch.drafts.map((draft) => ({
        ...draft,
        attachments: byDraft.get(draft.id) ?? [],
      })),
    };
  }

  private validateAttachmentsOrThrow(
    attachments: readonly T1AttachmentRef[] | undefined,
  ): T1AttachmentRef[] | undefined {
    if (attachments === undefined) return undefined;
    const checked = validateT1Attachments(attachments);
    if (!checked.ok) {
      const first = checked.errors[0]!;
      invalid(first.code, first.message);
    }
    return checked.valid;
  }

  async addDraft(tenant: OutreachTenant, batchId: string, input: OutreachDraftInput) {
    const normalized = normalizeDraft(input);
    const validatedAttachments = this.validateAttachmentsOrThrow(input.attachments);
    try {
      const draft = await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
        await this.requireDraftableBatchTx(tx, tenant, batchId);
        const existing = await tx.outreachDraft.count({ where: { batchId } });
        if (existing >= this.maxRecipients) {
          conflict(
            'OUTREACH_BATCH_SIZE_EXCEEDED',
            `单批收件人上限 ${this.maxRecipients}，请拆分为多个批次`,
          );
        }
        const created = await tx.outreachDraft.create({
          data: {
            workspaceId: tenant.workspaceId,
            batchId,
            ...normalized,
            recipientEmail: this.encryptDraftEmail(tenant.workspaceId, normalized.recipientEmail),
          },
        });
        return this.decryptDraft(tenant.workspaceId, created);
      });
      await this.event(tenant, batchId, 'DRAFT_ADDED', {
        draftId: draft.id,
        contactRef: normalized.contactRef,
      });
      if (validatedAttachments && validatedAttachments.length > 0) {
        await this.event(tenant, batchId, 'DRAFT_ATTACHMENTS_SET', {
          draftId: draft.id,
          attachments: validatedAttachments as unknown as Prisma.InputJsonValue,
        });
      }
      return validatedAttachments !== undefined
        ? { ...draft, attachments: validatedAttachments }
        : draft;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        conflict('OUTREACH_DRAFT_DUPLICATE_CONTACT', '同一批次内该联系人已有草稿');
      }
      throw error;
    }
  }

  async updateDraft(
    tenant: OutreachTenant,
    batchId: string,
    draftId: string,
    input: OutreachDraftInput,
  ) {
    const normalized = normalizeDraft(input);
    const validatedAttachments = this.validateAttachmentsOrThrow(input.attachments);
    const updated = await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
      await this.requireDraftableBatchTx(tx, tenant, batchId);
      const draft = await tx.outreachDraft.findFirst({
        where: { id: draftId, batchId, workspaceId: tenant.workspaceId },
      });
      if (!draft) {
        throw new NotFoundException({
          error: { code: 'OUTREACH_DRAFT_NOT_FOUND', message: '触达草稿不存在' },
        });
      }
      // PATCH 语义：未提供 countryCode 时保留原值，不能被整体替换悄悄清空。
      const data: Partial<typeof normalized> = { ...normalized };
      if (input.countryCode === undefined) delete data.countryCode;
      if (input.contactPointId === undefined) delete data.contactPointId;
      // 换了收件邮箱而未随附新通讯点 → 清空旧 pointId：回写按 pointId 寻址，
      // 旧 id 绑新邮箱会把退信记到别人的联系点上（引擎侧 INVALID 是粘滞的）。
      const existingEmail = this.decryptDraftEmail(tenant.workspaceId, draft.recipientEmail);
      if (normalized.recipientEmail !== existingEmail && input.contactPointId === undefined) {
        data.contactPointId = null;
      }
      data.recipientEmail = this.encryptDraftEmail(tenant.workspaceId, normalized.recipientEmail);
      const saved = await tx.outreachDraft.update({
        where: { id: draftId },
        data,
      });
      return this.decryptDraft(tenant.workspaceId, saved);
    });
    await this.event(tenant, batchId, 'DRAFT_EDITED', {
      draftId,
      contactRef: normalized.contactRef,
    });
    if (validatedAttachments !== undefined) {
      await this.event(tenant, batchId, 'DRAFT_ATTACHMENTS_SET', {
        draftId,
        attachments: validatedAttachments as unknown as Prisma.InputJsonValue,
      });
    }
    return validatedAttachments !== undefined
      ? { ...updated, attachments: validatedAttachments }
      : updated;
  }

  async removeDraft(tenant: OutreachTenant, batchId: string, draftId: string) {
    await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
      await this.requireDraftableBatchTx(tx, tenant, batchId);
      const deleted = await tx.outreachDraft.deleteMany({
        where: { id: draftId, batchId, workspaceId: tenant.workspaceId },
      });
      if (deleted.count === 0) {
        throw new NotFoundException({
          error: { code: 'OUTREACH_DRAFT_NOT_FOUND', message: '触达草稿不存在' },
        });
      }
    });
    await this.event(tenant, batchId, 'DRAFT_REMOVED', { draftId });
    return { removed: true };
  }

  async submitBatch(tenant: OutreachTenant, batchId: string) {
    if (!UUID_RE.test(batchId)) notFound();
    const { result, contentHash } = await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
      const batch = await tx.outreachBatch.findFirst({
        where: { workspaceId: tenant.workspaceId, id: batchId },
        include: { drafts: true },
      });
      if (!batch) notFound();
      if (batch.status !== 'DRAFT') {
        conflict('OUTREACH_BATCH_NOT_DRAFT', '只有草稿状态的批次可以提交审批');
      }
      if (batch.drafts.length === 0) {
        conflict('OUTREACH_BATCH_EMPTY', '批次内没有草稿');
      }
      if (batch.drafts.length > this.maxRecipients) {
        conflict(
          'OUTREACH_BATCH_SIZE_EXCEEDED',
          `批次收件人 ${batch.drafts.length} 超过单批上限 ${this.maxRecipients}`,
        );
      }
      const decryptedDrafts = batch.drafts.map((d) => this.decryptDraft(tenant.workspaceId, d));
      const nextHash = hashOutreachDrafts(decryptedDrafts);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.approvalTtlMs);
      const approval = await tx.outreachBatchApproval.create({
        data: {
          workspaceId: tenant.workspaceId,
          batchId,
          contentHash: nextHash,
          requestedBy: tenant.userId,
          expiresAt,
        },
      });
      await tx.outreachDraft.updateMany({
        where: { batchId, status: 'DRAFT' },
        data: { status: 'PENDING_APPROVAL', contentHash: nextHash },
      });
      await tx.outreachBatch.update({
        where: { id: batchId },
        data: {
          status: 'PENDING_APPROVAL',
          contentHash: nextHash,
          submittedAt: now,
          decidedAt: null,
          queuedAt: null,
        },
      });
      await tx.outreachBatchEvent.create({
        data: {
          workspaceId: tenant.workspaceId,
          batchId,
          type: 'BATCH_SUBMITTED',
          actor: tenant.userId,
          detail: { approvalId: approval.id, contentHash: nextHash, expiresAt: expiresAt.toISOString() },
        },
      });
      return { result: approval, contentHash: nextHash };
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      workspaceId: tenant.workspaceId,
      action: 'outreach.batch.submitted',
      target: batchId,
      detail: { approvalId: result.id, contentHash },
    });
    return result;
  }

  async decideApproval(
    tenant: OutreachTenant,
    batchId: string,
    approvalId: string,
    input: { decision: unknown; reason?: unknown },
  ) {
    if (!UUID_RE.test(batchId) || !UUID_RE.test(approvalId)) notFound();
    if (input.decision !== 'approve' && input.decision !== 'decline') {
      invalid('VALIDATION_ERROR', 'decision 必须是 approve 或 decline');
    }
    const reason =
      typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : null;
    await this.expireBatchIfStale(tenant, batchId);
    const requestedBy = await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
      const batch = await tx.outreachBatch.findFirst({
        where: { workspaceId: tenant.workspaceId, id: batchId },
      });
      if (!batch) notFound();
      const approval = await tx.outreachBatchApproval.findFirst({
        where: { id: approvalId, batchId, workspaceId: tenant.workspaceId },
      });
      if (!approval) {
        throw new NotFoundException({
          error: { code: 'OUTREACH_APPROVAL_NOT_FOUND', message: '审批不存在' },
        });
      }
      if (approval.state !== 'PENDING') {
        conflict('OUTREACH_APPROVAL_NOT_PENDING', '该审批已结束，不能重复裁决');
      }
      const now = new Date();
      if (input.decision === 'approve') {
        await tx.outreachBatchApproval.update({
          where: { id: approvalId },
          data: {
            state: 'APPROVED',
            decidedBy: tenant.userId,
            decidedAt: now,
            decisionReason: reason,
          },
        });
        await tx.outreachBatch.update({
          where: { id: batchId },
          data: { status: 'QUEUED', decidedAt: now, queuedAt: now },
        });
        await tx.outreachDraft.updateMany({
          where: { batchId, status: 'PENDING_APPROVAL' },
          data: { status: 'APPROVED', approvedBy: tenant.userId, approvedAt: now },
        });
        // P4-04：审批通过为每封草稿入队发送 job；幂等键吸收重复审批与重放。
        const approvedDrafts = await tx.outreachDraft.findMany({
          where: { batchId },
          select: { id: true },
        });
        await tx.outreachSendJob.createMany({
          data: approvedDrafts.map((draft) => ({
            workspaceId: tenant.workspaceId,
            batchId,
            draftId: draft.id,
            idempotencyKey: sendJobKey(batchId, draft.id),
          })),
          skipDuplicates: true,
        });
        await tx.outreachBatchEvent.create({
          data: {
            workspaceId: tenant.workspaceId,
            batchId,
            type: 'BATCH_APPROVED',
            actor: tenant.userId,
            detail: { approvalId, selfApproval: approval.requestedBy === tenant.userId },
          },
        });
      } else {
        await tx.outreachBatchApproval.update({
          where: { id: approvalId },
          data: {
            state: 'DECLINED',
            decidedBy: tenant.userId,
            decidedAt: now,
            decisionReason: reason,
          },
        });
        await tx.outreachBatch.update({
          where: { id: batchId },
          data: { status: 'DECLINED', decidedAt: now },
        });
        await tx.outreachDraft.updateMany({
          where: { batchId, status: 'PENDING_APPROVAL' },
          data: { status: 'REJECTED', rejectionReason: reason ?? 'declined' },
        });
        await tx.outreachBatchEvent.create({
          data: {
            workspaceId: tenant.workspaceId,
            batchId,
            type: 'BATCH_DECLINED',
            actor: tenant.userId,
            detail: { approvalId, reason },
          },
        });
      }
      return approval.requestedBy;
    });
    if (input.decision === 'approve') {
      await this.audit.record({
        realm: 'tenant',
        actorId: tenant.userId,
        workspaceId: tenant.workspaceId,
        action: 'outreach.batch.approved',
        target: batchId,
        detail: { approvalId, selfApproval: requestedBy === tenant.userId },
      });
      // P4-03 签发侧：默认不自动签发（OUTREACH_AUTHORIZATION_AUTO_ISSUE=false）；
      // 开启后审批即签发 v2 授权并绑定批次，失败只落事件、不回滚审批本身。
      if (this.config.OUTREACH_AUTHORIZATION_AUTO_ISSUE) {
        await this.authorizationIssuer.issue(tenant, batchId).catch(async (error) => {
          await this.event(tenant, batchId, 'AUTHORIZATION_ISSUE_FAILED', {
            code: authorizationErrorCode(error),
          });
        });
      }
    } else {
      await this.audit.record({
        realm: 'tenant',
        actorId: tenant.userId,
        workspaceId: tenant.workspaceId,
        action: 'outreach.batch.declined',
        target: batchId,
        detail: { approvalId, reason },
      });
    }
    return this.getBatch(tenant, batchId);
  }

  async reopenBatch(tenant: OutreachTenant, batchId: string) {
    await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
      const batch = await tx.outreachBatch.findFirst({
        where: { workspaceId: tenant.workspaceId, id: batchId },
      });
      if (!batch) notFound();
      if (batch.status !== 'DECLINED' && batch.status !== 'EXPIRED') {
        conflict('OUTREACH_BATCH_NOT_REOPENABLE', '只有被拒绝或过期的批次可以重新编辑');
      }
      await tx.outreachBatch.update({
        where: { id: batchId },
        data: {
          status: 'DRAFT',
          contentHash: null,
          submittedAt: null,
          decidedAt: null,
          queuedAt: null,
        },
      });
      await tx.outreachDraft.updateMany({
        where: { batchId, status: 'REJECTED' },
        data: { status: 'DRAFT', rejectionReason: null },
      });
      await tx.outreachBatchEvent.create({
        data: {
          workspaceId: tenant.workspaceId,
          batchId,
          type: 'BATCH_REOPENED',
          actor: tenant.userId,
        },
      });
    });
    return this.getBatch(tenant, batchId);
  }

  /**
   * 中小租户一键确认通道（M9-PR2）：
   * 当企业多级审批策略（OUTREACH_ENTERPRISE_APPROVAL_REQUIRED）关闭时，允许管理员在自动合规预检通过后
   * 一步完成内容冻结、留痕确认、入队发送 job 并签发 ExecutionAuthorization v2；
   * 全部法律与声誉底线（DNC / 退订 / DE-AT Opt-In / US-FR 页脚 / 熔断 / 预热上限）仍在发送器与预检中严格执行。
   */
  async quickConfirmBatch(
    tenant: OutreachTenant,
    batchId: string,
    options: { mailboxId?: string } = {},
  ): Promise<{
    batchId: string;
    approvalId: string;
    contentHash: string;
    authorizationId: string | null;
    status: string;
  }> {
    if (!UUID_RE.test(batchId)) notFound();
    if (this.config.OUTREACH_ENTERPRISE_APPROVAL_REQUIRED) {
      conflict(
        'OUTREACH_ENTERPRISE_APPROVAL_REQUIRED',
        '当前企业审批策略要求走两段式提交与审批流程，已禁用一键确认发送',
      );
    }
    const mailboxId = options.mailboxId?.trim() || undefined;
    if (mailboxId && !UUID_RE.test(mailboxId)) {
      invalid('VALIDATION_ERROR', 'mailboxId must be a UUID');
    }

    const confirmed = await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
      const batch = await tx.outreachBatch.findFirst({
        where: { workspaceId: tenant.workspaceId, id: batchId },
        include: { drafts: true },
      });
      if (!batch) notFound();
      if (batch.status !== 'DRAFT') {
        conflict('OUTREACH_BATCH_NOT_DRAFT', '只有草稿状态的批次可以使用一键确认通道');
      }
      if (batch.drafts.length === 0) {
        conflict('OUTREACH_BATCH_EMPTY', '批次内没有草稿');
      }
      if (batch.drafts.length > this.maxRecipients) {
        conflict(
          'OUTREACH_BATCH_SIZE_EXCEEDED',
          `批次收件人 ${batch.drafts.length} 超过单批上限 ${this.maxRecipients}`,
        );
      }
      if (mailboxId) {
        const mailbox = await tx.outreachMailbox.findFirst({
          where: { id: mailboxId, workspaceId: tenant.workspaceId },
          select: { id: true, state: true, address: true },
        });
        if (!mailbox) {
          throw new NotFoundException({
            error: { code: 'OUTREACH_MAILBOX_NOT_FOUND', message: '发件信箱不存在' },
          });
        }
        if (mailbox.state !== 'ACTIVE') {
          conflict(
            'OUTREACH_MAILBOX_PAUSED',
            `发件信箱 ${mailbox.address} 处于 ${mailbox.state} 状态，无法用于一键确认发送`,
          );
        }
      }

      const decryptedDrafts = batch.drafts.map((d) => this.decryptDraft(tenant.workspaceId, d));
      const nextHash = hashOutreachDrafts(decryptedDrafts);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.approvalTtlMs);

      const approval = await tx.outreachBatchApproval.create({
        data: {
          workspaceId: tenant.workspaceId,
          batchId,
          contentHash: nextHash,
          state: 'APPROVED',
          requestedBy: tenant.userId,
          decidedBy: tenant.userId,
          decidedAt: now,
          decisionReason: 'SMB_ONE_CLICK_CONFIRM',
          expiresAt,
        },
      });
      await tx.outreachDraft.updateMany({
        where: { batchId, status: 'DRAFT' },
        data: {
          status: 'APPROVED',
          contentHash: nextHash,
          approvedBy: tenant.userId,
          approvedAt: now,
        },
      });
      await tx.outreachBatch.update({
        where: { id: batchId },
        data: {
          status: 'QUEUED',
          contentHash: nextHash,
          submittedAt: now,
          decidedAt: now,
          queuedAt: now,
          ...(mailboxId ? { mailboxId } : {}),
        },
      });
      await tx.outreachSendJob.createMany({
        data: batch.drafts.map((draft) => ({
          workspaceId: tenant.workspaceId,
          batchId,
          draftId: draft.id,
          idempotencyKey: sendJobKey(batchId, draft.id),
        })),
        skipDuplicates: true,
      });
      await tx.outreachBatchEvent.create({
        data: {
          workspaceId: tenant.workspaceId,
          batchId,
          type: 'BATCH_QUICK_CONFIRMED',
          actor: tenant.userId,
          detail: {
            approvalId: approval.id,
            contentHash: nextHash,
            mode: 'smb_one_click',
            ...(mailboxId ? { mailboxId } : {}),
          },
        },
      });
      return { approvalId: approval.id, contentHash: nextHash };
    });

    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      workspaceId: tenant.workspaceId,
      action: 'outreach.batch.quick_confirmed',
      target: batchId,
      detail: {
        approvalId: confirmed.approvalId,
        contentHash: confirmed.contentHash,
        ...(mailboxId ? { mailboxId } : {}),
      },
    });

    let authorizationId: string | null = null;
    if (this.authorizationIssuer?.issue) {
      const issued = await this.authorizationIssuer.issue(tenant, batchId);
      const authObj = (issued as { authorization?: { id?: unknown }; authorizationId?: unknown; id?: unknown });
      authorizationId =
        typeof authObj?.authorization?.id === 'string'
          ? authObj.authorization.id
          : typeof authObj?.authorizationId === 'string'
            ? authObj.authorizationId
            : typeof authObj?.id === 'string'
              ? authObj.id
              : null;
    }

    return {
      batchId,
      approvalId: confirmed.approvalId,
      contentHash: confirmed.contentHash,
      authorizationId,
      status: 'QUEUED',
    };
  }

  private async requireDraftableBatchTx(
    tx: Prisma.TransactionClient,
    tenant: OutreachTenant,
    batchId: string,
  ) {
    if (!UUID_RE.test(batchId)) notFound();
    const batch = await tx.outreachBatch.findFirst({
      where: { workspaceId: tenant.workspaceId, id: batchId },
    });
    if (!batch) notFound();
    if (batch.status !== 'DRAFT') {
      conflict('OUTREACH_BATCH_NOT_DRAFT', '提交审批后草稿已冻结，需重新打开批次');
    }
    return batch;
  }

  private async expireStaleBatches(tenant: OutreachTenant) {
    const stale = await this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
      tx.outreachBatchApproval.findMany({
        where: {
          workspaceId: tenant.workspaceId,
          state: 'PENDING',
          expiresAt: { lte: new Date() },
        },
        select: { batchId: true },
      }),
    );
    for (const row of stale) {
      await this.expireBatchIfStale(tenant, row.batchId);
    }
  }

  private async expireBatchIfStale(tenant: OutreachTenant, batchId: string) {
    await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
      const approval = await tx.outreachBatchApproval.findFirst({
        where: {
          workspaceId: tenant.workspaceId,
          batchId,
          state: 'PENDING',
          expiresAt: { lte: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!approval) return;
      const now = new Date();
      await tx.outreachBatchApproval.update({
        where: { id: approval.id },
        data: { state: 'EXPIRED', decidedAt: now, decisionReason: 'expired' },
      });
      await tx.outreachBatch.update({
        where: { id: batchId },
        data: { status: 'EXPIRED', decidedAt: now },
      });
      await tx.outreachDraft.updateMany({
        where: { batchId, status: 'PENDING_APPROVAL' },
        data: { status: 'REJECTED', rejectionReason: 'expired' },
      });
      await tx.outreachBatchEvent.create({
        data: {
          workspaceId: tenant.workspaceId,
          batchId,
          type: 'BATCH_EXPIRED',
          actor: 'system',
          detail: { approvalId: approval.id },
        },
      });
    });
  }

  private async event(
    tenant: OutreachTenant,
    batchId: string,
    type: string,
    detail?: Record<string, unknown>,
  ) {
    await this.prisma
      .withWorkspace(tenant.workspaceId, (tx) =>
        tx.outreachBatchEvent.create({
          data: {
            workspaceId: tenant.workspaceId,
            batchId,
            type,
            actor: tenant.userId,
            detail: (detail ?? undefined) as Prisma.InputJsonValue | undefined,
          },
        }),
      )
      .catch(() => undefined);
  }
}


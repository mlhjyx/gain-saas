import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';

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
  recipientEmail: string;
  companyName?: string | null;
  subject: string;
  body: string;
}

function normalizeDraft(input: OutreachDraftInput) {
  if (!UUID_RE.test(input.contactRef)) {
    invalid('VALIDATION_ERROR', 'contactRef must be a UUID');
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
  return { contactRef: input.contactRef, recipientEmail, companyName, subject, body };
}

/**
 * 触达批次与草稿审批（M2 步 11-2）。
 * 语义复用 M2.0：审批单元=内容哈希、超时=拒绝、旧同意不可复用（提交后草稿冻结）、自审留痕。
 * 批准只把批次置为 QUEUED；发送开关与执行器在 11-3，默认不发。
 */
@Injectable()
export class OutreachBatchService {
  private readonly approvalTtlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.approvalTtlMs = config.OUTREACH_APPROVAL_TTL_HOURS * 3600_000;
  }

  async createBatch(
    tenant: OutreachTenant,
    input: { name: unknown; campaignId?: unknown },
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
    const batch = await this.prisma.outreachBatch.create({
      data: {
        workspaceId: tenant.workspaceId,
        campaignId,
        name,
        createdBy: tenant.userId,
      },
    });
    await this.event(tenant, batch.id, 'BATCH_CREATED', { name });
    return batch;
  }

  async listBatches(tenant: OutreachTenant) {
    await this.expireStaleBatches(tenant);
    const rows = await this.prisma.outreachBatch.findMany({
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
    });
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
    const batch = await this.prisma.outreachBatch.findFirst({
      where: { workspaceId: tenant.workspaceId, id: batchId },
      include: {
        drafts: { orderBy: { createdAt: 'asc' } },
        approvals: { orderBy: { createdAt: 'desc' } },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!batch) notFound();
    return batch;
  }

  async addDraft(tenant: OutreachTenant, batchId: string, input: OutreachDraftInput) {
    const normalized = normalizeDraft(input);
    await this.requireDraftableBatch(tenant, batchId);
    try {
      const draft = await this.prisma.outreachDraft.create({
        data: {
          workspaceId: tenant.workspaceId,
          batchId,
          ...normalized,
        },
      });
      await this.event(tenant, batchId, 'DRAFT_ADDED', {
        draftId: draft.id,
        contactRef: normalized.contactRef,
      });
      return draft;
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
    await this.requireDraftableBatch(tenant, batchId);
    const draft = await this.prisma.outreachDraft.findFirst({
      where: { id: draftId, batchId, workspaceId: tenant.workspaceId },
    });
    if (!draft) {
      throw new NotFoundException({
        error: { code: 'OUTREACH_DRAFT_NOT_FOUND', message: '触达草稿不存在' },
      });
    }
    const updated = await this.prisma.outreachDraft.update({
      where: { id: draftId },
      data: normalized,
    });
    await this.event(tenant, batchId, 'DRAFT_EDITED', {
      draftId,
      contactRef: normalized.contactRef,
    });
    return updated;
  }

  async removeDraft(tenant: OutreachTenant, batchId: string, draftId: string) {
    await this.requireDraftableBatch(tenant, batchId);
    const deleted = await this.prisma.outreachDraft.deleteMany({
      where: { id: draftId, batchId, workspaceId: tenant.workspaceId },
    });
    if (deleted.count === 0) {
      throw new NotFoundException({
        error: { code: 'OUTREACH_DRAFT_NOT_FOUND', message: '触达草稿不存在' },
      });
    }
    await this.event(tenant, batchId, 'DRAFT_REMOVED', { draftId });
    return { removed: true };
  }

  async submitBatch(tenant: OutreachTenant, batchId: string) {
    if (!UUID_RE.test(batchId)) notFound();
    const batch = await this.prisma.outreachBatch.findFirst({
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
    const contentHash = hashDrafts(batch.drafts);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.approvalTtlMs);
    const result = await this.prisma.$transaction(async (tx) => {
      const approval = await tx.outreachBatchApproval.create({
        data: {
          workspaceId: tenant.workspaceId,
          batchId,
          contentHash,
          requestedBy: tenant.userId,
          expiresAt,
        },
      });
      await tx.outreachDraft.updateMany({
        where: { batchId, status: 'DRAFT' },
        data: { status: 'PENDING_APPROVAL', contentHash },
      });
      await tx.outreachBatch.update({
        where: { id: batchId },
        data: {
          status: 'PENDING_APPROVAL',
          contentHash,
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
          detail: { approvalId: approval.id, contentHash, expiresAt: expiresAt.toISOString() },
        },
      });
      return approval;
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
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
    const batch = await this.prisma.outreachBatch.findFirst({
      where: { workspaceId: tenant.workspaceId, id: batchId },
    });
    if (!batch) notFound();
    const approval = await this.prisma.outreachBatchApproval.findFirst({
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
      await this.prisma.$transaction(async (tx) => {
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
        await tx.outreachBatchEvent.create({
          data: {
            workspaceId: tenant.workspaceId,
            batchId,
            type: 'BATCH_APPROVED',
            actor: tenant.userId,
            detail: { approvalId, selfApproval: approval.requestedBy === tenant.userId },
          },
        });
      });
      await this.audit.record({
        realm: 'tenant',
        actorId: tenant.userId,
        action: 'outreach.batch.approved',
        target: batchId,
        detail: { approvalId, selfApproval: approval.requestedBy === tenant.userId },
      });
    } else {
      await this.prisma.$transaction(async (tx) => {
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
      });
      await this.audit.record({
        realm: 'tenant',
        actorId: tenant.userId,
        action: 'outreach.batch.declined',
        target: batchId,
        detail: { approvalId, reason },
      });
    }
    return this.getBatch(tenant, batchId);
  }

  async reopenBatch(tenant: OutreachTenant, batchId: string) {
    const batch = await this.prisma.outreachBatch.findFirst({
      where: { workspaceId: tenant.workspaceId, id: batchId },
    });
    if (!batch) notFound();
    if (batch.status !== 'DECLINED' && batch.status !== 'EXPIRED') {
      conflict('OUTREACH_BATCH_NOT_REOPENABLE', '只有被拒绝或过期的批次可以重新编辑');
    }
    await this.prisma.$transaction(async (tx) => {
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

  private async requireDraftableBatch(tenant: OutreachTenant, batchId: string) {
    if (!UUID_RE.test(batchId)) notFound();
    const batch = await this.prisma.outreachBatch.findFirst({
      where: { workspaceId: tenant.workspaceId, id: batchId },
    });
    if (!batch) notFound();
    if (batch.status !== 'DRAFT') {
      conflict('OUTREACH_BATCH_NOT_DRAFT', '提交审批后草稿已冻结，需重新打开批次');
    }
    return batch;
  }

  private async expireStaleBatches(tenant: OutreachTenant) {
    const stale = await this.prisma.outreachBatchApproval.findMany({
      where: {
        workspaceId: tenant.workspaceId,
        state: 'PENDING',
        expiresAt: { lte: new Date() },
      },
      select: { batchId: true },
    });
    for (const row of stale) {
      await this.expireBatchIfStale(tenant, row.batchId);
    }
  }

  private async expireBatchIfStale(tenant: OutreachTenant, batchId: string) {
    const approval = await this.prisma.outreachBatchApproval.findFirst({
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
    await this.prisma.$transaction(async (tx) => {
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
    await this.prisma.outreachBatchEvent
      .create({
        data: {
          workspaceId: tenant.workspaceId,
          batchId,
          type,
          actor: tenant.userId,
          detail: (detail ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      })
      .catch(() => undefined);
  }
}

function hashDrafts(
  drafts: ReadonlyArray<{
    contactRef: string;
    recipientEmail: string;
    subject: string;
    body: string;
  }>,
): string {
  const canonical = drafts
    .map((draft) => ({
      contactRef: draft.contactRef,
      recipientEmail: draft.recipientEmail.trim().toLowerCase(),
      subject: draft.subject,
      body: draft.body,
    }))
    .sort((left, right) =>
      left.contactRef < right.contactRef ? -1 : left.contactRef > right.contactRef ? 1 : 0,
    );
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

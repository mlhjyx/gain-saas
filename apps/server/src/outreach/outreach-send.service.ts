import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AppConfig } from '../config/configuration.js';
import { APP_CONFIG } from '../shared/config.module.js';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import { hashDraftField, hashJson, hashOutreachDrafts } from './outreach-content.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import { OutreachSendGate } from './outreach-send.gate.js';
import {
  OUTREACH_TRANSPORT,
  type OutreachTransport,
} from './outreach-smtp.transport.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// SENT 也纳入校验：重试/续发时已发送的草稿仍必须带完整批准证据，跳过由台账决定。
const SENDABLE_DRAFT_STATUSES = new Set(['APPROVED', 'FAILED', 'SENT']);

function notFound(): never {
  throw new NotFoundException({
    error: { code: 'OUTREACH_BATCH_NOT_FOUND', message: '触达批次不存在' },
  });
}
function conflict(code: string, message: string): never {
  throw new ConflictException({ error: { code, message } });
}

export interface OutreachSendSummary {
  batchId: string;
  status: string;
  sent: number;
  failed: number;
  skipped: number;
  results: Array<{
    draftId: string;
    status: 'SENT' | 'FAILED' | 'SKIPPED';
    messageId?: string;
    error?: string;
  }>;
}

/**
 * 触达发送执行器（M2 步 11-3）。
 * 门序：总开关 → 批次在待发队列 → 审批未过期且内容哈希一致 → 逐封已批准 → SMTP 已配置。
 * 任一封不满足即整批拒绝（不发送任何一封）；发送前先落审计包，发送后逐封写 append-only 台账。
 */
@Injectable()
export class OutreachSendService {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly gate: OutreachSendGate,
    @Inject(OUTREACH_TRANSPORT) private readonly transport: OutreachTransport,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async sendBatch(tenant: OutreachTenant, batchId: string): Promise<OutreachSendSummary> {
    this.gate.assertEnabled();
    if (!UUID_RE.test(batchId)) notFound();

    const lockKey = `${tenant.workspaceId}:${batchId}`;
    if (this.inFlight.has(lockKey)) {
      conflict('OUTREACH_BATCH_SEND_IN_PROGRESS', '该批次正在发送，请稍后刷新');
    }
    this.inFlight.add(lockKey);
    try {
      return await this.doSendBatch(tenant, batchId);
    } finally {
      this.inFlight.delete(lockKey);
    }
  }

  private async doSendBatch(
    tenant: OutreachTenant,
    batchId: string,
  ): Promise<OutreachSendSummary> {
    const batch = await this.prisma.outreachBatch.findFirst({
      where: { workspaceId: tenant.workspaceId, id: batchId },
      include: {
        drafts: { orderBy: { createdAt: 'asc' } },
        approvals: {
          where: { state: 'APPROVED' },
          orderBy: { decidedAt: 'desc' },
          take: 1,
        },
        sends: true,
      },
    });
    if (!batch) notFound();

    if (batch.status === 'SENT') {
      conflict('OUTREACH_BATCH_ALREADY_SENT', '该批次已发送，不能重复发送');
    }
    if (batch.status !== 'QUEUED') {
      conflict('OUTREACH_BATCH_NOT_QUEUED', '只有已批准进入待发队列的批次可以发送');
    }
    if (batch.drafts.length === 0) {
      conflict('OUTREACH_BATCH_EMPTY', '批次内没有草稿');
    }

    const approval = batch.approvals[0];
    if (!approval || !batch.contentHash || approval.contentHash !== batch.contentHash) {
      conflict('OUTREACH_APPROVAL_MISSING', '批次缺少与当前内容匹配的批准，拒绝发送');
    }
    if (approval.expiresAt.getTime() <= Date.now()) {
      conflict('OUTREACH_APPROVAL_EXPIRED', '批准已过期，需重新提交审批后才能发送');
    }
    if (hashOutreachDrafts(batch.drafts) !== batch.contentHash) {
      conflict('OUTREACH_CONTENT_CHANGED', '批次内容与批准时不一致，拒绝发送');
    }

    for (const draft of batch.drafts) {
      if (
        !SENDABLE_DRAFT_STATUSES.has(draft.status) ||
        !draft.approvedBy ||
        !draft.approvedAt ||
        draft.contentHash !== batch.contentHash
      ) {
        conflict(
          'OUTREACH_DRAFT_NOT_APPROVED',
          `草稿 ${draft.id} 未获批准或批准已失效，整批拒绝发送`,
        );
      }
    }

    try {
      this.transport.ensureConfigured();
    } catch (error) {
      throw new ServiceUnavailableException({
        error: {
          code: 'OUTREACH_SMTP_NOT_CONFIGURED',
          message:
            error instanceof Error ? error.message : 'SMTP 出口未配置，拒绝发送',
        },
      });
    }

    await this.persistAuditPackage(tenant, batchId, tenant.userId);

    const sentDraftIds = new Set(
      batch.sends.filter((send) => send.status === 'SENT').map((send) => send.draftId),
    );
    const pending = batch.drafts
      .filter((draft) => !sentDraftIds.has(draft.id))
      .slice(0, this.config.OUTREACH_SEND_BATCH_LIMIT);

    const results: OutreachSendSummary['results'] = [];
    for (const draft of pending) {
      const attempt =
        Math.max(
          0,
          ...batch.sends
            .filter((send) => send.draftId === draft.id)
            .map((send) => send.attempt),
        ) + 1;
      try {
        const { messageId } = await this.transport.send({
          to: draft.recipientEmail,
          subject: draft.subject,
          body: draft.body,
        });
        await this.prisma.$transaction([
          this.prisma.outreachSend.create({
            data: {
              workspaceId: tenant.workspaceId,
              batchId,
              draftId: draft.id,
              attempt,
              recipientEmail: draft.recipientEmail,
              subjectHash: hashDraftField(draft.subject),
              bodyHash: hashDraftField(draft.body),
              mailboxAddress: this.config.OUTREACH_SMTP_FROM_ADDRESS ?? 'unconfigured',
              messageId,
              status: 'SENT',
              sentAt: new Date(),
            },
          }),
          this.prisma.outreachDraft.update({
            where: { id: draft.id },
            data: { status: 'SENT' },
          }),
        ]);
        sentDraftIds.add(draft.id);
        results.push({ draftId: draft.id, status: 'SENT', messageId });
      } catch (error) {
        const message = error instanceof Error ? error.message : '发送失败';
        await this.prisma.$transaction([
          this.prisma.outreachSend.create({
            data: {
              workspaceId: tenant.workspaceId,
              batchId,
              draftId: draft.id,
              attempt,
              recipientEmail: draft.recipientEmail,
              subjectHash: hashDraftField(draft.subject),
              bodyHash: hashDraftField(draft.body),
              mailboxAddress: this.config.OUTREACH_SMTP_FROM_ADDRESS ?? 'unconfigured',
              status: 'FAILED',
              error: message.slice(0, 1000),
            },
          }),
          this.prisma.outreachDraft.update({
            where: { id: draft.id },
            data: { status: 'FAILED' },
          }),
        ]);
        results.push({ draftId: draft.id, status: 'FAILED', error: message });
      }
    }

    const allSent = batch.drafts.every((draft) => sentDraftIds.has(draft.id));
    const failed = results.filter((result) => result.status === 'FAILED').length;
    const sent = results.filter((result) => result.status === 'SENT').length;
    const attemptedDraftIds = new Set(results.map((result) => result.draftId));
    const skipped = batch.drafts.filter(
      (draft) => !sentDraftIds.has(draft.id) && !attemptedDraftIds.has(draft.id),
    ).length;

    if (allSent) {
      await this.prisma.$transaction([
        this.prisma.outreachBatch.update({
          where: { id: batchId },
          data: { status: 'SENT' },
        }),
        this.prisma.outreachBatchEvent.create({
          data: {
            workspaceId: tenant.workspaceId,
            batchId,
            type: 'BATCH_SENT',
            actor: tenant.userId,
            detail: { sent, failed },
          },
        }),
      ]);
    } else if (results.length > 0) {
      await this.prisma.outreachBatchEvent.create({
        data: {
          workspaceId: tenant.workspaceId,
          batchId,
          type: 'BATCH_SEND_PARTIAL',
          actor: tenant.userId,
          detail: { sent, failed, remaining: skipped },
        },
      });
    }

    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: allSent ? 'outreach.batch.sent' : 'outreach.batch.send_partial',
      target: batchId,
      detail: { sent, failed, skipped },
    });

    await this.persistAuditPackage(tenant, batchId, tenant.userId);

    return {
      batchId,
      status: allSent ? 'SENT' : 'QUEUED',
      sent,
      failed,
      skipped,
      results,
    };
  }

  /**
   * 审计包预览/导出：谁批、何时、发什么、合规依据，全部来自当前数据库事实。
   * 发送前后各持久化一份（内容寻址），保证事后可追溯。
   */
  async getAuditPackage(tenant: OutreachTenant, batchId: string) {
    if (!UUID_RE.test(batchId)) notFound();
    const assembled = await this.assembleAuditPackage(tenant, batchId);
    if (!assembled) notFound();
    const persisted = await this.prisma.outreachAuditPackage.findFirst({
      where: {
        workspaceId: tenant.workspaceId,
        batchId,
        packageHash: assembled.packageHash,
      },
    });
    return {
      package: assembled.package,
      packageHash: assembled.packageHash,
      persistedAt: persisted?.createdAt ?? null,
    };
  }

  private async persistAuditPackage(
    tenant: OutreachTenant,
    batchId: string,
    actor: string,
  ) {
    const assembled = await this.assembleAuditPackage(tenant, batchId);
    if (!assembled) return;
    const exists = await this.prisma.outreachAuditPackage.findFirst({
      where: { batchId, packageHash: assembled.packageHash },
      select: { id: true },
    });
    if (exists) return;
    await this.prisma.outreachAuditPackage
      .create({
        data: {
          workspaceId: tenant.workspaceId,
          batchId,
          contentHash: assembled.contentHash,
          package: assembled.package as Prisma.InputJsonValue,
          packageHash: assembled.packageHash,
          createdBy: actor,
        },
      })
      .catch(() => undefined);
  }

  private async assembleAuditPackage(tenant: OutreachTenant, batchId: string) {
    const batch = await this.prisma.outreachBatch.findFirst({
      where: { workspaceId: tenant.workspaceId, id: batchId },
      include: {
        drafts: { orderBy: { createdAt: 'asc' } },
        approvals: { orderBy: { createdAt: 'desc' } },
        events: { orderBy: { createdAt: 'asc' } },
        sends: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!batch) return null;

    const contactRefs = [...new Set(batch.drafts.map((draft) => draft.contactRef))];
    const consents =
      contactRefs.length > 0
        ? await this.prisma.outreachConsent.findMany({
            where: {
              workspaceId: tenant.workspaceId,
              channel: 'email',
              contactRef: { in: contactRefs },
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          })
        : [];
    const latestConsent = new Map<string, (typeof consents)[number]>();
    for (const consent of consents) {
      if (!latestConsent.has(consent.contactRef)) {
        latestConsent.set(consent.contactRef, consent);
      }
    }

    const approval =
      batch.approvals.find((row) => row.state === 'APPROVED') ?? batch.approvals[0] ?? null;

    const packageData = {
      schemaVersion: 'outreach-audit-package/v1',
      generatedAt: new Date().toISOString(),
      workspaceId: tenant.workspaceId,
      batch: {
        id: batch.id,
        name: batch.name,
        campaignId: batch.campaignId,
        status: batch.status,
        contentHash: batch.contentHash,
        createdBy: batch.createdBy,
        submittedAt: batch.submittedAt?.toISOString() ?? null,
        decidedAt: batch.decidedAt?.toISOString() ?? null,
        queuedAt: batch.queuedAt?.toISOString() ?? null,
      },
      approval: approval
        ? {
            id: approval.id,
            state: approval.state,
            contentHash: approval.contentHash,
            requestedBy: approval.requestedBy,
            decidedBy: approval.decidedBy,
            decidedAt: approval.decidedAt?.toISOString() ?? null,
            expiresAt: approval.expiresAt.toISOString(),
            decisionReason: approval.decisionReason,
            selfApproval:
              approval.requestedBy !== null && approval.requestedBy === approval.decidedBy,
          }
        : null,
      drafts: batch.drafts.map((draft) => {
        const consent = latestConsent.get(draft.contactRef);
        return {
          draftId: draft.id,
          contactRef: draft.contactRef,
          recipientEmail: draft.recipientEmail,
          companyName: draft.companyName,
          subject: draft.subject,
          body: draft.body,
          subjectHash: hashDraftField(draft.subject),
          bodyHash: hashDraftField(draft.body),
          contentHash: draft.contentHash,
          status: draft.status,
          approvedBy: draft.approvedBy,
          approvedAt: draft.approvedAt?.toISOString() ?? null,
          complianceBasis: {
            consentStatus: consent?.status ?? null,
            consentSource: consent?.source ?? null,
            lawfulBasis: consent?.lawfulBasis ?? null,
            consentRecordedAt: consent?.createdAt.toISOString() ?? null,
            approvalContentHash: approval?.contentHash ?? null,
          },
          sends: batch.sends
            .filter((send) => send.draftId === draft.id)
            .map((send) => ({
              attempt: send.attempt,
              status: send.status,
              messageId: send.messageId,
              error: send.error,
              sentAt: send.sentAt?.toISOString() ?? null,
              createdAt: send.createdAt.toISOString(),
            })),
        };
      }),
      events: batch.events.map((event) => ({
        type: event.type,
        actor: event.actor,
        detail: event.detail,
        createdAt: event.createdAt.toISOString(),
      })),
    };
    return {
      package: packageData,
      packageHash: hashJson(packageData),
      contentHash: batch.contentHash ?? hashJson(packageData),
    };
  }
}

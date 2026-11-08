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
import {
  OUTREACH_DNC_CHECKER,
  type OutreachTenant,
} from './outreach-consent.service.js';
import type { OutreachDncChecker } from './outreach-dnc.checker.js';
import { OutreachSendGate } from './outreach-send.gate.js';
import {
  OUTREACH_TRANSPORT,
  type OutreachTransport,
} from './outreach-smtp.transport.js';
import { OutreachUnsubscribeService } from './outreach-unsubscribe.service.js';

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
    @Inject(OUTREACH_DNC_CHECKER) private readonly dnc: OutreachDncChecker,
    private readonly unsubscribe: OutreachUnsubscribeService,
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
    if (batch.status === 'COMPLETED') {
      conflict('OUTREACH_BATCH_ALREADY_COMPLETED', '该批次已处理完毕，不能重复发送');
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
      // 已按退订/DNC 跳过的草稿不再参与发送，也不再要求重新批准。
      if (draft.status === 'SKIPPED') continue;
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
    const skippedDraftIds = new Set(
      batch.sends.filter((send) => send.status === 'SKIPPED').map((send) => send.draftId),
    );
    const pending = batch.drafts
      .filter((draft) => !sentDraftIds.has(draft.id) && !skippedDraftIds.has(draft.id))
      .slice(0, this.config.OUTREACH_SEND_BATCH_LIMIT);
    const skipReasons = await this.computeSkipReasons(tenant, pending);

    const results: OutreachSendSummary['results'] = [];
    for (const draft of pending) {
      const attempt =
        Math.max(
          0,
          ...batch.sends
            .filter((send) => send.draftId === draft.id)
            .map((send) => send.attempt),
        ) + 1;
      const skipReason = skipReasons.get(draft.id);
      if (skipReason) {
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
              status: 'SKIPPED',
              error: skipReason.slice(0, 1000),
            },
          }),
          this.prisma.outreachDraft.update({
            where: { id: draft.id },
            data: { status: 'SKIPPED' },
          }),
          this.prisma.outreachBatchEvent.create({
            data: {
              workspaceId: tenant.workspaceId,
              batchId,
              type: 'DRAFT_SKIPPED',
              actor: tenant.userId,
              detail: { draftId: draft.id, reason: skipReason },
            },
          }),
        ]);
        skippedDraftIds.add(draft.id);
        results.push({ draftId: draft.id, status: 'SKIPPED', error: skipReason });
        continue;
      }

      try {
        const unsubscribe = await this.unsubscribe.issue(
          tenant,
          draft.contactRef,
          draft.recipientEmail,
        );
        const unsubscribeUrl = this.unsubscribeUrl(unsubscribe.token);
        const { messageId } = await this.transport.send({
          to: draft.recipientEmail,
          subject: draft.subject,
          body: `${draft.body}\r\n\r\n---\r\nAbmelden / Unsubscribe: ${unsubscribeUrl}`,
          headers: {
            'List-Unsubscribe': `<${unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
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
    const allTerminal = batch.drafts.every(
      (draft) => sentDraftIds.has(draft.id) || skippedDraftIds.has(draft.id),
    );
    const failed = results.filter((result) => result.status === 'FAILED').length;
    const sent = results.filter((result) => result.status === 'SENT').length;
    const skipped = results.filter((result) => result.status === 'SKIPPED').length;
    const attemptedDraftIds = new Set(results.map((result) => result.draftId));
    const remaining = batch.drafts.filter(
      (draft) =>
        !sentDraftIds.has(draft.id) &&
        !skippedDraftIds.has(draft.id) &&
        !attemptedDraftIds.has(draft.id),
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
    } else if (allTerminal) {
      await this.prisma.$transaction([
        this.prisma.outreachBatch.update({
          where: { id: batchId },
          data: { status: 'COMPLETED' },
        }),
        this.prisma.outreachBatchEvent.create({
          data: {
            workspaceId: tenant.workspaceId,
            batchId,
            type: 'BATCH_COMPLETED',
            actor: tenant.userId,
            detail: { sent, failed, skipped },
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
          detail: { sent, failed, skipped, remaining },
        },
      });
    }

    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: allSent
        ? 'outreach.batch.sent'
        : allTerminal
          ? 'outreach.batch.completed'
          : 'outreach.batch.send_partial',
      target: batchId,
      detail: { sent, failed, skipped },
    });

    await this.persistAuditPackage(tenant, batchId, tenant.userId);

    return {
      batchId,
      status: allSent ? 'SENT' : allTerminal ? 'COMPLETED' : 'QUEUED',
      sent,
      failed,
      skipped,
      results,
    };
  }

  private unsubscribeUrl(token: string): string {
    const base = this.config.OUTREACH_UNSUBSCRIBE_BASE_URL.replace(/\/+$/, '');
    return `${base}/api/public/outreach/unsubscribe?token=${encodeURIComponent(token)}`;
  }

  /**
   * 发送前逐封跳过判定：最新同意为 OPT_OUT（含回复/退订回写）或 DNC 命中。
   * DNC 查询失败时 fail closed（整批不发送），不把不可达的禁联名单当成“没命中”。
   */
  private async computeSkipReasons(
    tenant: OutreachTenant,
    drafts: ReadonlyArray<{ id: string; contactRef: string; recipientEmail: string }>,
  ): Promise<Map<string, string>> {
    const reasons = new Map<string, string>();
    if (drafts.length === 0) return reasons;

    const contactRefs = [...new Set(drafts.map((draft) => draft.contactRef))];
    const consents = await this.prisma.outreachConsent.findMany({
      where: {
        workspaceId: tenant.workspaceId,
        channel: 'email',
        contactRef: { in: contactRefs },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const latest = new Map<string, (typeof consents)[number]>();
    for (const consent of consents) {
      if (!latest.has(consent.contactRef)) latest.set(consent.contactRef, consent);
    }
    for (const draft of drafts) {
      if (latest.get(draft.contactRef)?.status === 'OPT_OUT') {
        reasons.set(draft.id, 'OUTREACH_OPTED_OUT');
      }
    }

    const remaining = drafts.filter((draft) => !reasons.has(draft.id));
    if (remaining.length === 0) return reasons;
    let suppressed: Map<string, string[]>;
    try {
      suppressed = await this.dnc.check(
        tenant,
        remaining.map((draft) => draft.recipientEmail),
      );
    } catch {
      throw new ServiceUnavailableException({
        error: {
          code: 'OUTREACH_DNC_UNAVAILABLE',
          message: '禁联名单检查失败，拒绝发送',
        },
      });
    }
    for (const draft of remaining) {
      const hit = suppressed.get(draft.recipientEmail.trim().toLowerCase());
      if (hit && hit.length > 0) {
        reasons.set(draft.id, `OUTREACH_DNC_BLOCKED: ${hit.join(',')}`);
      }
    }
    return reasons;
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

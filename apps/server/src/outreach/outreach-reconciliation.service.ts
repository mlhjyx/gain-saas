import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';

export type ReconciliationCode =
  | 'SENT_WITHOUT_MESSAGE_ID'
  | 'SEND_WITHOUT_AUTHORIZATION_USE'
  | 'DRAFT_MISSING'
  | 'LEDGER_SENT_DRAFT_NOT_SENT'
  | 'DRAFT_SENT_WITHOUT_LEDGER'
  | 'DUPLICATE_SENT_ATTEMPTS'
  | 'SKIPPED_WITHOUT_REASON';

export interface ReconciliationDiscrepancy {
  code: ReconciliationCode;
  batchId: string;
  draftId: string;
  sendId?: string;
}

export interface ReconciliationResult {
  day: string;
  counts: { sends: number; draftsInScope: number };
  discrepancies: ReconciliationDiscrepancy[];
  ok: boolean;
  limitations: string[];
}

function utcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

/**
 * 发送台账日对账（P4-14，E5-12 的「自己的账」半边）：
 * 核对 outreach_send 与草稿状态、授权消费、消息 id 的勾稽关系，任何缺口即 ok=false 并逐条列出。
 * 外部半边（SMTP/信箱已发送数、供应商回执）需要真实收发凭据，属发车后的对账验收。
 * 无 schema 变更；纯只读查询。
 */
@Injectable()
export class OutreachReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async reconcile(tenant: OutreachTenant, dayInput?: Date): Promise<ReconciliationResult> {
    const day = utcDay(dayInput ?? new Date(Date.now() - 86_400_000));
    const dayEnd = new Date(day.getTime() + 86_400_000);
    const sends = await this.prisma.outreachSend.findMany({
      where: {
        workspaceId: tenant.workspaceId,
        createdAt: { gte: day, lt: dayEnd },
      },
      select: {
        id: true,
        batchId: true,
        draftId: true,
        status: true,
        messageId: true,
        authorizationId: true,
        authorizationUse: true,
        error: true,
      },
    });
    const batchIds = [...new Set(sends.map((send) => send.batchId))];
    const draftIds = [...new Set(sends.map((send) => send.draftId))];
    const drafts =
      draftIds.length > 0
        ? await this.prisma.outreachDraft.findMany({
            where: { id: { in: draftIds } },
            select: { id: true, status: true },
          })
        : [];
    const draftStatus = new Map(drafts.map((draft) => [draft.id, draft.status]));

    // 台账声称 SENT 的草稿，必须真的有一条 SENT 台账（任意日期，覆盖跨日重试）。
    const sentLedgerDraftIds = new Set(
      sends.filter((send) => send.status === 'SENT').map((send) => send.draftId),
    );
    const batchDrafts =
      batchIds.length > 0
        ? await this.prisma.outreachDraft.findMany({
            where: { batchId: { in: batchIds }, status: 'SENT' },
            select: { id: true, batchId: true },
          })
        : [];
    const allSentForDrafts =
      batchDrafts.length > 0
        ? await this.prisma.outreachSend.findMany({
            where: {
              workspaceId: tenant.workspaceId,
              draftId: { in: batchDrafts.map((draft) => draft.id) },
              status: 'SENT',
            },
            select: { draftId: true },
          })
        : [];
    const everSent = new Set(allSentForDrafts.map((row) => row.draftId));

    const discrepancies: ReconciliationDiscrepancy[] = [];
    const sentPerDraft = new Map<string, number>();
    for (const send of sends) {
      if (send.status === 'SENT') {
        if (!send.messageId) {
          discrepancies.push({
            code: 'SENT_WITHOUT_MESSAGE_ID',
            batchId: send.batchId,
            draftId: send.draftId,
            sendId: send.id,
          });
        }
        if (!send.authorizationId || send.authorizationUse === null) {
          discrepancies.push({
            code: 'SEND_WITHOUT_AUTHORIZATION_USE',
            batchId: send.batchId,
            draftId: send.draftId,
            sendId: send.id,
          });
        }
        sentPerDraft.set(send.draftId, (sentPerDraft.get(send.draftId) ?? 0) + 1);
      }
      if (send.status === 'SKIPPED' && !send.error) {
        discrepancies.push({
          code: 'SKIPPED_WITHOUT_REASON',
          batchId: send.batchId,
          draftId: send.draftId,
          sendId: send.id,
        });
      }
      const status = draftStatus.get(send.draftId);
      if (status === undefined) {
        discrepancies.push({
          code: 'DRAFT_MISSING',
          batchId: send.batchId,
          draftId: send.draftId,
          sendId: send.id,
        });
      } else if (send.status === 'SENT' && status !== 'SENT') {
        discrepancies.push({
          code: 'LEDGER_SENT_DRAFT_NOT_SENT',
          batchId: send.batchId,
          draftId: send.draftId,
          sendId: send.id,
        });
      }
    }
    for (const draft of batchDrafts) {
      if (!everSent.has(draft.id)) {
        discrepancies.push({
          code: 'DRAFT_SENT_WITHOUT_LEDGER',
          batchId: draft.batchId,
          draftId: draft.id,
        });
      }
    }
    for (const [draftId, count] of sentPerDraft) {
      if (count > 1) {
        const sample = sends.find((send) => send.draftId === draftId)!;
        discrepancies.push({
          code: 'DUPLICATE_SENT_ATTEMPTS',
          batchId: sample.batchId,
          draftId,
        });
      }
    }

    const result: ReconciliationResult = {
      day: day.toISOString().slice(0, 10),
      counts: { sends: sends.length, draftsInScope: batchDrafts.length },
      discrepancies,
      ok: discrepancies.length === 0,
      limitations: [
        '只核对本系统台账内部勾稽；信箱服务商/供应商侧已发送数需要真实收发凭据后接入（E5-12 外部半边）',
        'SKIPPED 草稿不计入 DRAFT_SENT_WITHOUT_LEDGER（跳过不是发送）',
      ],
    };
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.reconciliation.checked',
      target: result.day,
      detail: { ok: result.ok, discrepancies: discrepancies.length },
    });
    return result;
  }

  parseDay(value: unknown): Date | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      invalid('date 必须是 YYYY-MM-DD');
    }
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) invalid('date 不是合法日期');
    return parsed;
  }
}

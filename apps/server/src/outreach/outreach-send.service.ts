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
import {
  OutreachAuthorizationConsumer,
  type OutreachAuthorizationGrant,
} from './outreach-authorization.consumer.js';
import {
  evaluateEmailJurisdiction,
  normalizeCountry,
  outreachJurisdictionPolicy,
} from './outreach-jurisdiction.js';
import { OutreachSendGate } from './outreach-send.gate.js';
import { OutreachSendControls } from './outreach-send-controls.js';
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

function errorCodeOf(error: unknown, fallback: string): string {
  const code = (error as { response?: { error?: { code?: unknown } } })?.response?.error?.code;
  return typeof code === 'string' ? code : fallback;
}

function errorMessageOf(error: unknown, fallback: string): string {
  // Nest HttpException 的 .message 对对象响应恒为 "Conflict Exception"；具体原因在 response.error.message。
  const message = (error as { response?: { error?: { message?: unknown } } })?.response?.error
    ?.message;
  if (typeof message === 'string' && message) return message;
  return error instanceof Error && error.message ? error.message : fallback;
}

export interface OutreachSendSummary {
  batchId: string;
  status: string;
  sent: number;
  failed: number;
  skipped: number;
  /** 发送窗口外/同域限速顺延的封数（不写台账，草稿保持待发）。 */
  deferred: number;
  /** 影子模式（CAMPAIGN_EXECUTION_SHADOW）下只记录不投递的封数。 */
  shadowed: number;
  results: Array<{
    draftId: string;
    status: 'SENT' | 'FAILED' | 'SKIPPED' | 'DEFERRED' | 'SHADOWED';
    messageId?: string;
    error?: string;
  }>;
}

interface DraftPreflight {
  skip?: {
    code: string;
    message: string;
    countryCode: string;
    jurisdictionPolicy: string;
  };
  /** 该法域要求的页脚行（US 物理地址 / FR 来源告知），发送时拼装。 */
  footerLines: string[];
}

interface PreflightDraft {
  id: string;
  contactRef: string;
  recipientEmail: string;
  countryCode: string | null;
}

/**
 * 触达发送执行器（M2 步 11-3，P4 首波扩展）。
 * 门序：总开关 → 批次状态 → 审批未过期且内容哈希一致 → 逐封已批准 → 单批规模
 * → SMTP 已配置 → 执行授权 v2（batchId/内容哈希/收件人集合/caps/schedule/budget/jurisdiction）
 * → 退信/投诉熔断 → 法域同意门（DE/AT 无 OPT_IN 不发；US/FR 页脚必需）→ DNC（fail-closed）
 * → 控制面（信箱日/周上限、收件人当地窗口、同域限速）。
 * 批次级门（总开关/批次状态/审批与内容哈希/逐封批准/单批规模/SMTP/执行授权/熔断）
 * 任一不满足即整批拒绝（不发送任何一封）；逐封门（法域同意/DNC）不满足时该封 SKIPPED、
 * 其余照发；窗口/限速/信箱额度不满足时该封顺延（草稿保持待发，不写失败台账）。
 * `CAMPAIGN_EXECUTION_SHADOW=true`（默认）时只做全部门序校验与事件记录，不投递、不消费授权。
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
    private readonly controls: OutreachSendControls,
    private readonly authorization: OutreachAuthorizationConsumer,
  ) {}

  async sendBatch(tenant: OutreachTenant, batchId: string): Promise<OutreachSendSummary> {
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

    try {
      this.gate.assertEnabled();
    } catch (error) {
      await this.rejectBatch(
        tenant,
        batchId,
        'OUTREACH_SEND_DISABLED',
        error instanceof Error ? error.message : '发送通道未开启',
        'conflict',
      );
    }

    if (batch.status === 'SENT') {
      await this.rejectBatch(tenant, batchId, 'OUTREACH_BATCH_ALREADY_SENT', '该批次已发送，不能重复发送');
    }
    if (batch.status === 'COMPLETED') {
      await this.rejectBatch(
        tenant,
        batchId,
        'OUTREACH_BATCH_ALREADY_COMPLETED',
        '该批次已处理完毕，不能重复发送',
      );
    }
    if (batch.status !== 'QUEUED') {
      await this.rejectBatch(
        tenant,
        batchId,
        'OUTREACH_BATCH_NOT_QUEUED',
        '只有已批准进入待发队列的批次可以发送',
      );
    }
    if (batch.drafts.length === 0) {
      await this.rejectBatch(tenant, batchId, 'OUTREACH_BATCH_EMPTY', '批次内没有草稿');
    }

    const approval = batch.approvals[0];
    if (!approval || !batch.contentHash || approval.contentHash !== batch.contentHash) {
      await this.rejectBatch(
        tenant,
        batchId,
        'OUTREACH_APPROVAL_MISSING',
        '批次缺少与当前内容匹配的批准，拒绝发送',
      );
    }
    if (approval.expiresAt.getTime() <= Date.now()) {
      await this.rejectBatch(
        tenant,
        batchId,
        'OUTREACH_APPROVAL_EXPIRED',
        '批准已过期，需重新提交审批后才能发送',
      );
    }
    if (hashOutreachDrafts(batch.drafts) !== batch.contentHash) {
      await this.rejectBatch(
        tenant,
        batchId,
        'OUTREACH_CONTENT_CHANGED',
        '批次内容与批准时不一致，拒绝发送',
      );
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
        await this.rejectBatch(
          tenant,
          batchId,
          'OUTREACH_DRAFT_NOT_APPROVED',
          `草稿 ${draft.id} 未获批准或批准已失效，整批拒绝发送`,
        );
      }
    }

    try {
      this.transport.ensureConfigured();
    } catch (error) {
      await this.rejectBatch(
        tenant,
        batchId,
        'OUTREACH_SMTP_NOT_CONFIGURED',
        error instanceof Error ? error.message : 'SMTP 出口未配置，拒绝发送',
        'unavailable',
      );
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
    const now = new Date();

    // G3：执行授权 v2（只读消费；无有效授权整批拒绝）。
    let grant!: OutreachAuthorizationGrant;
    try {
      grant = await this.authorization.authorizeBatch(
        tenant,
        batch,
        batch.drafts,
        pending.map((draft) => draft.id),
      );
    } catch (error) {
      await this.rejectBatch(
        tenant,
        batchId,
        errorCodeOf(error, 'CAMPAIGN_AUTHORIZATION_INVALID'),
        errorMessageOf(error, '执行授权校验失败'),
      );
    }

    // G6：退信/投诉熔断（滚动窗口），命中即整批停发。
    try {
      await this.controls.assertHealthy(tenant, now);
    } catch (error) {
      await this.rejectBatch(
        tenant,
        batchId,
        errorCodeOf(error, 'OUTREACH_MAILBOX_PAUSED'),
        errorMessageOf(error, '发送健康度熔断'),
      );
    }
    // 授权 scope 里更紧的 caps 收紧本批次的 env 上限（授权是上界，env 是默认值）。
    const controlState = await this.controls.beginBatch(tenant, now, grant.action.caps);

    // 逐封预检：法域同意 → DNC → 控制面（窗口/限速顺延，上限跳过）。
    let preflight!: Map<string, DraftPreflight>;
    try {
      preflight = await this.preflightDrafts(tenant, pending);
    } catch (error) {
      await this.rejectBatch(
        tenant,
        batchId,
        errorCodeOf(error, 'OUTREACH_DNC_UNAVAILABLE'),
        errorMessageOf(error, '禁联名单检查失败'),
        'unavailable',
      );
    }

    const shadow = this.config.CAMPAIGN_EXECUTION_SHADOW === true;
    const results: OutreachSendSummary['results'] = [];
    let deferredCount = 0;
    let shadowedCount = 0;
    for (const draft of pending) {
      const attempt =
        Math.max(
          0,
          ...batch.sends
            .filter((send) => send.draftId === draft.id)
            .map((send) => send.attempt),
        ) + 1;
      const plan = preflight.get(draft.id) ?? { footerLines: [] };
      if (plan.skip) {
        if (shadow) {
          // 影子模式只读：判定「真实发送会跳过」但不写 SKIPPED 台账、不改草稿状态。
          await this.recordDraftEvent(tenant, batchId, draft, 'SEND_SHADOWED', {
            wouldSkip: plan.skip.code,
            reason: plan.skip.message,
          });
          shadowedCount += 1;
          results.push({ draftId: draft.id, status: 'SHADOWED', error: plan.skip.code });
          continue;
        }
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
              mailboxAddress: this.controls.mailboxAddress(),
              authorizationId: grant.authorizationId,
              status: 'SKIPPED',
              error: plan.skip.code.slice(0, 1000),
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
              detail: {
                draftId: draft.id,
                contactRef: draft.contactRef,
                countryCode: plan.skip.countryCode,
                jurisdictionPolicy: plan.skip.jurisdictionPolicy,
                code: plan.skip.code,
                reason: plan.skip.message,
              } as Prisma.InputJsonValue,
            },
          }),
        ]);
        skippedDraftIds.add(draft.id);
        results.push({ draftId: draft.id, status: 'SKIPPED', error: plan.skip.code });
        continue;
      }
      // 控制面逐封评估（必须在发送循环内）：计数随本批已成功发送递进，
      // 否则单批可以突破信箱日/周上限与同域每小时限速。
      const verdict = this.controls.checkDraft(controlState, {
        recipientEmail: draft.recipientEmail,
        countryCode: draft.countryCode,
        now,
      });
      if (verdict.action === 'DEFER') {
        await this.recordDraftEvent(tenant, batchId, draft, 'DRAFT_DEFERRED', {
          code: verdict.code,
          reason: '信箱额度已满、发送窗口未开或同收件域限速，顺延到下一窗口',
        });
        deferredCount += 1;
        results.push({ draftId: draft.id, status: 'DEFERRED', error: verdict.code });
        continue;
      }
      if (shadow) {
        await this.recordDraftEvent(tenant, batchId, draft, 'SEND_SHADOWED', {
          authorizationId: grant.authorizationId,
          jurisdictionPolicy: outreachJurisdictionPolicy(draft.countryCode),
          footerLines: plan.footerLines.length,
        });
        shadowedCount += 1;
        results.push({ draftId: draft.id, status: 'SHADOWED' });
        continue;
      }

      let authorizationUse!: number;
      try {
        authorizationUse = await this.authorization.consumeForDraft(tenant, grant, draft.id);
      } catch (error) {
        // 授权次数在批次中途耗尽属授权边界被击穿：整批拒绝（已写台账的封保持事实）。
        await this.rejectBatch(
          tenant,
          batchId,
          errorCodeOf(error, 'CAMPAIGN_AUTHORIZATION_USES_EXHAUSTED'),
          errorMessageOf(error, '执行授权次数不足'),
        );
      }

      try {
        const unsubscribe = await this.unsubscribe.issue(
          tenant,
          draft.contactRef,
          draft.recipientEmail,
        );
        const unsubscribeUrl = this.unsubscribeUrl(unsubscribe.token);
        const footer = ['---', ...plan.footerLines, `Abmelden / Unsubscribe: ${unsubscribeUrl}`].join(
          '\r\n',
        );
        const { messageId } = await this.transport.send({
          to: draft.recipientEmail,
          subject: draft.subject,
          body: `${draft.body}\r\n\r\n${footer}`,
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
              mailboxAddress: this.controls.mailboxAddress(),
              authorizationId: grant.authorizationId,
              authorizationUse,
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
        this.controls.recordSent(controlState, draft.recipientEmail);
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
              mailboxAddress: this.controls.mailboxAddress(),
              authorizationId: grant.authorizationId,
              authorizationUse,
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
    const attemptedDraftIds = new Set(
      results
        .filter((result) => result.status !== 'DEFERRED' && result.status !== 'SHADOWED')
        .map((result) => result.draftId),
    );
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
          detail: { sent, failed, skipped, deferred: deferredCount, shadowed: shadowedCount, remaining },
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
      detail: {
        sent,
        failed,
        skipped,
        deferred: deferredCount,
        shadowed: shadowedCount,
        authorizationId: grant.authorizationId,
      },
    });

    await this.persistAuditPackage(tenant, batchId, tenant.userId);

    return {
      batchId,
      status: allSent ? 'SENT' : allTerminal ? 'COMPLETED' : 'QUEUED',
      sent,
      failed,
      skipped,
      deferred: deferredCount,
      shadowed: shadowedCount,
      results,
    };
  }

  private async recordDraftEvent(
    tenant: OutreachTenant,
    batchId: string,
    draft: PreflightDraft,
    type: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    // 不顺延吞错：影子/顺延事件是这两种运行状态的唯一证据，写失败必须暴露。
    await this.prisma.outreachBatchEvent.create({
      data: {
        workspaceId: tenant.workspaceId,
        batchId,
        type,
        actor: tenant.userId,
        detail: {
          draftId: draft.id,
          contactRef: draft.contactRef,
          countryCode: normalizeCountry(draft.countryCode),
          jurisdictionPolicy: outreachJurisdictionPolicy(draft.countryCode),
          ...detail,
        } as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * 门拒绝也留审计工件（13-1 G4）：批次事件 + 审计包 + audit.record，然后抛 409/503。
   * 不写 outreach_send：没有发生任何发送尝试。
   */
  private async rejectBatch(
    tenant: OutreachTenant,
    batchId: string,
    code: string,
    message: string,
    status: 'conflict' | 'unavailable' = 'conflict',
  ): Promise<never> {
    await this.prisma.outreachBatchEvent
      .create({
        data: {
          workspaceId: tenant.workspaceId,
          batchId,
          type: 'BATCH_REJECTED',
          actor: tenant.userId,
          detail: { code, message } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
    await this.persistAuditPackage(tenant, batchId, tenant.userId).catch(() => undefined);
    await this.audit
      .record({
        realm: 'tenant',
        actorId: tenant.userId,
        action: 'outreach.batch.rejected',
        target: batchId,
        detail: { code, message },
      })
      .catch(() => undefined);
    if (status === 'unavailable') {
      throw new ServiceUnavailableException({ error: { code, message } });
    }
    throw new ConflictException({ error: { code, message } });
  }

  private unsubscribeUrl(token: string): string {
    const base = this.config.OUTREACH_UNSUBSCRIBE_BASE_URL.replace(/\/+$/, '');
    return `${base}/api/public/outreach/unsubscribe?token=${encodeURIComponent(token)}`;
  }

  /**
   * 发送前逐封预检（P4-01）：
   * 1) 法域同意门（DE/AT 无 OPT_IN 不发；US/FR 缺页脚配置不发；其它法域 REVIEW_REQUIRED）；
   * 2) DNC 命中（租户/平台），查询失败 fail closed（整批不发送）。
   * 控制面（窗口/限速/额度）在发送循环里逐封评估——必须看到本批已发计数才有效。
   */
  private async preflightDrafts(
    tenant: OutreachTenant,
    drafts: ReadonlyArray<PreflightDraft>,
  ): Promise<Map<string, DraftPreflight>> {
    const result = new Map<string, DraftPreflight>();
    if (drafts.length === 0) return result;

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
      const decision = evaluateEmailJurisdiction({
        countryCode: draft.countryCode,
        consentStatus: latest.get(draft.contactRef)?.status ?? 'MISSING',
        usPostalAddress: this.config.OUTREACH_US_POSTAL_ADDRESS,
        frSourceNotice: this.config.OUTREACH_FR_SOURCE_NOTICE,
      });
      if (!decision.allowed) {
        result.set(draft.id, {
          skip: {
            code: decision.code ?? 'JURISDICTION_REVIEW_REQUIRED',
            message: decision.message ?? '法域策略拒绝',
            countryCode: normalizeCountry(draft.countryCode),
            jurisdictionPolicy: decision.policy,
          },
          footerLines: [],
        });
      } else {
        result.set(draft.id, { footerLines: decision.footerLines });
      }
    }

    const remaining = drafts.filter((draft) => !result.get(draft.id)?.skip);
    if (remaining.length > 0) {
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
          const entry = result.get(draft.id)!;
          entry.skip = {
            code: `OUTREACH_DNC_BLOCKED: ${hit.join(',')}`,
            message: '收件邮箱在禁联名单或全局抑制中',
            countryCode: normalizeCountry(draft.countryCode),
            jurisdictionPolicy: outreachJurisdictionPolicy(draft.countryCode),
          };
        }
      }
    }

    return result;
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
        authorizationId: batch.authorizationId,
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
          countryCode: draft.countryCode,
          jurisdictionPolicy: outreachJurisdictionPolicy(draft.countryCode),
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
              authorizationId: send.authorizationId,
              authorizationUse: send.authorizationUse,
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
    // 内容寻址只覆盖事实：generatedAt 每次组装都不同，若计入哈希则 persistedAt 永远匹配不到。
    const hashablePackage = Object.fromEntries(
      Object.entries(packageData).filter(([key]) => key !== 'generatedAt'),
    );
    return {
      package: packageData,
      packageHash: hashJson(hashablePackage),
      contentHash: batch.contentHash ?? hashJson(hashablePackage),
    };
  }
}

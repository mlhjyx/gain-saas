import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import {
  hashOutreachAudience,
  hashOutreachDraftSet,
  hashOutreachDrafts,
} from '../outreach/outreach-content.js';
import { CampaignTokenSigner } from './campaign-token.signer.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface OutreachIssuerTenant {
  userId: string;
  workspaceId: string;
  role: 'admin' | 'member';
}

function conflict(code: string, message: string): never {
  throw new ConflictException({ error: { code, message } });
}
function notFound(): never {
  throw new NotFoundException({
    error: { code: 'OUTREACH_BATCH_NOT_FOUND', message: '触达批次不存在' },
  });
}

/**
 * 触达批次的 ExecutionAuthorization v2 签发与绑定（P4-03 签发侧，关闭 P4-13 的工程前置）。
 *
 * 签发只读已批准批次的事实（批内草稿 + 已批准审批 + 内容哈希），派生 scope：
 * batchId / 收件人集合哈希 / 草稿集哈希 / caps（env 上界）/ schedule / budget / jurisdiction。
 * 哈希函数与消费端（outreach-authorization.consumer）共用 outreach-content.ts 的同一实现。
 * 幂等：批次已绑定「未过期的 ISSUED 授权」时直接返回；REVOKED/过期则签发新授权并改绑。
 * 默认不自动签发（OUTREACH_AUTHORIZATION_AUTO_ISSUE=false）；可经管理员端点在批次批准后手动签发。
 */
@Injectable()
export class OutreachAuthorizationIssuer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly signer: CampaignTokenSigner,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async issue(tenant: OutreachIssuerTenant, batchId: string) {
    if (!UUID_RE.test(batchId)) notFound();
    const batch = await this.prisma.outreachBatch.findFirst({
      where: { id: batchId, workspaceId: tenant.workspaceId },
      include: {
        drafts: { orderBy: { createdAt: 'asc' } },
        approvals: {
          where: { state: 'APPROVED' },
          orderBy: { decidedAt: 'desc' },
          take: 1,
        },
      },
    });
    if (!batch) notFound();
    if (batch.status !== 'QUEUED') {
      conflict('OUTREACH_BATCH_NOT_QUEUED', '只有已批准进入待发队列的批次可以签发执行授权');
    }
    const approval = batch.approvals[0];
    if (!approval || !batch.contentHash || approval.contentHash !== batch.contentHash) {
      conflict('OUTREACH_APPROVAL_MISSING', '批次缺少与当前内容匹配的批准，不能签发授权');
    }
    if (approval.expiresAt.getTime() <= Date.now()) {
      conflict('OUTREACH_APPROVAL_EXPIRED', '批准已过期，需重新审批后才能签发授权');
    }
    if (hashOutreachDrafts(batch.drafts) !== batch.contentHash) {
      conflict('OUTREACH_CONTENT_CHANGED', '批次内容与批准时不一致，不能签发授权');
    }
    if (batch.drafts.length === 0) {
      conflict('OUTREACH_BATCH_EMPTY', '批次内没有草稿');
    }

    const now = new Date();
    if (batch.authorizationId) {
      const existing = await this.prisma.campaignExecutionAuthorization.findFirst({
        where: { id: batch.authorizationId, workspaceId: tenant.workspaceId },
      });
      if (existing && existing.state === 'ISSUED' && existing.expiresAt.getTime() > now.getTime()) {
        return { authorization: existing, created: false };
      }
    }

    const contactRefs = batch.drafts.map((draft) => draft.contactRef);
    const countries = [
      ...new Set(
        batch.drafts
          .map((draft) => (draft.countryCode ?? '').trim().toUpperCase())
          .filter((country) => country.length > 0),
      ),
    ].sort();
    const notAfter = new Date(
      now.getTime() + this.config.OUTREACH_AUTHZ_SCHEDULE_DAYS * 86_400_000,
    );
    const ttlMs = Math.max(
      60_000,
      Math.min(this.config.OUTREACH_AUTHZ_TTL_MINUTES * 60_000, notAfter.getTime() - now.getTime()),
    );
    const expiresAt = new Date(now.getTime() + ttlMs);
    const scope = {
      schemaVersion: 'campaign-authz/v2',
      campaignId: batch.campaignId,
      actions: [
        {
          type: 'outreach.email.send',
          batchId: batch.id,
          audience: {
            contactRefsHash: hashOutreachAudience(contactRefs),
            count: batch.drafts.length,
            sizeCap: this.config.OUTREACH_BATCH_MAX_RECIPIENTS,
          },
          template: {
            contentHash: batch.contentHash,
            draftSetHash: hashOutreachDraftSet(batch.drafts),
          },
          caps: {
            perMailboxDaily: this.config.OUTREACH_MAILBOX_DAILY_CAP,
            perMailboxWeekly: this.config.OUTREACH_MAILBOX_WEEKLY_CAP,
            perDomainHourly: this.config.OUTREACH_DOMAIN_HOURLY_CAP,
            batchMax: this.config.OUTREACH_BATCH_MAX_RECIPIENTS,
          },
          schedule: {
            notBefore: now.toISOString(),
            notAfter: notAfter.toISOString(),
          },
          budget: {
            currency: 'USD',
            capMicros: batch.drafts.length * this.config.OUTREACH_COST_PER_EMAIL_MICROS,
          },
          jurisdiction: {
            policyVersion: 'outreach-jurisdiction/v0',
            allowedCountries: countries,
            deniedCountries: [] as string[],
          },
        },
      ],
    };
    const authorizationId = randomUUID();
    const token = await this.signer.sign(
      {
        authorizationId,
        workspaceId: tenant.workspaceId,
        // 无 campaign 的独立批次：claims 里的 campaign/revision 用批次自身承载（消费端按 DB 行校验）。
        campaignId: batch.campaignId ?? batch.id,
        revisionId: batch.id,
        planHash: batch.contentHash,
        scope,
      },
      Math.floor(ttlMs / 1000),
    );

    const authorization = await this.prisma.$transaction(async (tx) => {
      const row = await tx.campaignExecutionAuthorization.create({
        data: {
          id: authorizationId,
          workspaceId: tenant.workspaceId,
          campaignId: batch.campaignId ?? batch.id,
          revisionId: batch.id,
          planHash: batch.contentHash!,
          scope: scope as unknown as Prisma.InputJsonValue,
          token,
          state: 'ISSUED',
          maxUses: batch.drafts.length,
          uses: 0,
          expiresAt,
        },
      });
      await tx.outreachBatch.update({
        where: { id: batch.id },
        data: { authorizationId },
      });
      await tx.outreachBatchEvent.create({
        data: {
          workspaceId: tenant.workspaceId,
          batchId: batch.id,
          type: 'AUTHORIZATION_ISSUED',
          actor: tenant.userId,
          detail: {
            authorizationId,
            maxUses: batch.drafts.length,
            expiresAt: expiresAt.toISOString(),
          } as Prisma.InputJsonValue,
        },
      });
      return row;
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.authorization.issued',
      target: batch.id,
      detail: { authorizationId, maxUses: batch.drafts.length },
    });
    return { authorization, created: true };
  }
}

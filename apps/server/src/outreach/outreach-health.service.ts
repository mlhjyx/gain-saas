import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';

const SCOPES = ['mailbox', 'domain', 'workspace'] as const;
type BreakerScope = (typeof SCOPES)[number];

export interface BatchHealthVerdict {
  /** HALF_OPEN 复核期的小批上限（ch05 §5.3.5.6：≤10 封）；未设限时 undefined。 */
  maxSend?: number;
}

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}
function notFound(): never {
  throw new NotFoundException({
    error: { code: 'OUTREACH_BREAKER_NOT_FOUND', message: '熔断器记录不存在' },
  });
}
function scopeCode(scope: BreakerScope): string {
  return scope === 'domain' ? 'OUTREACH_DOMAIN_PAUSED' : 'OUTREACH_MAILBOX_PAUSED';
}

/**
 * 熔断器持久态（P4-08）：CLOSED →（评估命中）OPEN →（人工恢复）HALF_OPEN →（人工复核）CLOSED。
 * 评估口径（窗口=OUTREACH_BOUNCE_WINDOW_DAYS）：
 * - mailbox：SMTP 硬拒率（可归因到信箱；DSN 退信没有信箱归因，计入 domain 口径）；
 * - domain：退信率（DSN 退信 + SMTP 硬拒）≥10% 或投诉率 ≥0.3%（各有最小样本）。
 * 负面回复率/成本每会议/合规违规的自动化本期不落（缺模板归因、成本口径与违规信号源）。
 */
@Injectable()
export class OutreachHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async evaluateWorkspace(
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<{ opened: number }> {
    const windowDays = this.config.OUTREACH_BOUNCE_WINDOW_DAYS;
    const windowMinutes = windowDays * 1440;
    const since = new Date(now.getTime() - windowDays * 86_400_000);
    let opened = 0;

    const mailboxes = await this.prisma.outreachMailbox.findMany({
      where: { workspaceId },
      select: { address: true },
    });
    for (const mailbox of mailboxes) {
      const [sends, hardRejects] = await Promise.all([
        this.prisma.outreachSend.count({
          where: {
            workspaceId,
            mailboxAddress: mailbox.address,
            status: 'SENT',
            sentAt: { gte: since },
          },
        }),
        this.prisma.outreachSend.count({
          where: {
            workspaceId,
            mailboxAddress: mailbox.address,
            status: 'FAILED',
            bounceType: 'HARD',
            createdAt: { gte: since },
          },
        }),
      ]);
      const attempts = sends + hardRejects;
      const rate = attempts > 0 ? hardRejects / attempts : 0;
      if (
        attempts >= this.config.OUTREACH_BOUNCE_MIN_SAMPLE &&
        rate >= this.config.OUTREACH_BOUNCE_RATE_HALT
      ) {
        if (
          await this.openBreaker(workspaceId, 'mailbox', mailbox.address, 'HARD_BOUNCE_RATE', rate, {
            threshold: this.config.OUTREACH_BOUNCE_RATE_HALT,
            windowMinutes,
            detail: { sends, hardRejects },
            now,
          })
        ) {
          opened += 1;
        }
      }
    }

    const senderDomain = (this.config.OUTREACH_SMTP_FROM_ADDRESS ?? '').split('@')[1];
    if (senderDomain) {
      const [sends, dsnBounces, hardRejects, complaints] = await Promise.all([
        this.prisma.outreachSend.count({
          where: { workspaceId, status: 'SENT', sentAt: { gte: since } },
        }),
        this.prisma.outreachReply.count({
          where: { workspaceId, kind: 'BOUNCE', receivedAt: { gte: since } },
        }),
        this.prisma.outreachSend.count({
          where: {
            workspaceId,
            status: 'FAILED',
            bounceType: 'HARD',
            createdAt: { gte: since },
          },
        }),
        this.prisma.outreachReply.count({
          where: { workspaceId, kind: 'COMPLAINT', receivedAt: { gte: since } },
        }),
      ]);
      const attempts = sends + hardRejects;
      const bounceRate = attempts > 0 ? (dsnBounces + hardRejects) / attempts : 0;
      if (
        attempts >= this.config.OUTREACH_BOUNCE_MIN_SAMPLE &&
        bounceRate >= this.config.OUTREACH_DOMAIN_BOUNCE_HALT_RATE
      ) {
        if (
          await this.openBreaker(workspaceId, 'domain', senderDomain, 'BOUNCE_RATE', bounceRate, {
            threshold: this.config.OUTREACH_DOMAIN_BOUNCE_HALT_RATE,
            windowMinutes,
            detail: { sends, dsnBounces, hardRejects },
            now,
          })
        ) {
          opened += 1;
        }
      }
      const complaintRate = sends > 0 ? complaints / sends : 0;
      if (
        sends >= this.config.OUTREACH_COMPLAINT_MIN_SAMPLE &&
        complaintRate >= this.config.OUTREACH_COMPLAINT_RATE_HALT
      ) {
        if (
          await this.openBreaker(workspaceId, 'domain', senderDomain, 'COMPLAINT_RATE', complaintRate, {
            threshold: this.config.OUTREACH_COMPLAINT_RATE_HALT,
            windowMinutes,
            detail: { sends, complaints },
            now,
          })
        ) {
          opened += 1;
        }
      }
    }
    return { opened };
  }

  /** 批次级：OPEN → 整批停发；HALF_OPEN → 返回小批上限。 */
  async assertBatchAllowed(
    tenant: OutreachTenant,
    input: { mailboxAddress?: string; domain?: string },
  ): Promise<BatchHealthVerdict> {
    let maxSend: number | undefined;
    const checks: Array<[BreakerScope, string | undefined]> = [
      ['mailbox', input.mailboxAddress?.toLowerCase()],
      ['domain', input.domain?.toLowerCase()],
    ];
    for (const [scope, scopeRef] of checks) {
      if (!scopeRef) continue;
      const breaker = await this.prisma.outreachBreaker.findUnique({
        where: { workspaceId_scope_scopeRef: { workspaceId: tenant.workspaceId, scope, scopeRef } },
      });
      if (!breaker || breaker.state === 'CLOSED') continue;
      if (breaker.state === 'OPEN') {
        throw new ConflictException({
          error: {
            code: scopeCode(scope),
            message: `发送已熔断（${scope}:${scopeRef}，原因 ${breaker.reason ?? 'UNKNOWN'}），需运营复核后恢复`,
          },
        });
      }
      if (breaker.state === 'HALF_OPEN') {
        maxSend = Math.min(maxSend ?? Number.MAX_SAFE_INTEGER, this.config.OUTREACH_HALF_OPEN_BATCH_LIMIT);
      }
    }
    return maxSend === undefined ? {} : { maxSend };
  }

  /** 人工恢复第一步：OPEN → HALF_OPEN（必须给根因说明；下一批按 ≤N 封复核）。 */
  async recover(tenant: OutreachTenant, scope: string, scopeRef: string, reason: unknown) {
    const normalizedScope = this.normalizeScope(scope);
    const ref = this.normalizeRef(scopeRef);
    const note = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';
    if (!note) invalid('恢复必须填写根因说明');
    const breaker = await this.getBreaker(tenant, normalizedScope, ref);
    if (breaker.state !== 'OPEN') {
      throw new ConflictException({
        error: { code: 'OUTREACH_BREAKER_NOT_OPEN', message: `熔断器状态为 ${breaker.state}，不能执行恢复` },
      });
    }
    const now = new Date();
    const updated = await this.prisma.outreachBreaker.update({
      where: {
        workspaceId_scope_scopeRef: { workspaceId: tenant.workspaceId, scope: normalizedScope, scopeRef: ref },
      },
      data: { state: 'HALF_OPEN', halfOpenAt: now, resolvedBy: tenant.userId },
    });
    await this.recordEvent(tenant, normalizedScope, ref, 'RECOVER', note, now);
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.breaker.recovered',
      target: `${normalizedScope}:${ref}`,
      detail: { reason: note },
    });
    return updated;
  }

  /** 人工复核通过：HALF_OPEN → CLOSED（关闭前需人工确认小批结果）。 */
  async close(tenant: OutreachTenant, scope: string, scopeRef: string, reason: unknown) {
    const normalizedScope = this.normalizeScope(scope);
    const ref = this.normalizeRef(scopeRef);
    const note = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';
    if (!note) invalid('关闭必须填写复核说明');
    const breaker = await this.getBreaker(tenant, normalizedScope, ref);
    if (breaker.state !== 'HALF_OPEN') {
      throw new ConflictException({
        error: { code: 'OUTREACH_BREAKER_NOT_HALF_OPEN', message: `熔断器状态为 ${breaker.state}，不能执行关闭` },
      });
    }
    const now = new Date();
    const updated = await this.prisma.outreachBreaker.update({
      where: {
        workspaceId_scope_scopeRef: { workspaceId: tenant.workspaceId, scope: normalizedScope, scopeRef: ref },
      },
      data: { state: 'CLOSED', resolvedAt: now, resolvedBy: tenant.userId, reason: null },
    });
    await this.recordEvent(tenant, normalizedScope, ref, 'CLOSE', note, now);
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.breaker.closed',
      target: `${normalizedScope}:${ref}`,
      detail: { reason: note },
    });
    return updated;
  }

  async panel(tenant: OutreachTenant) {
    const [breakers, events] = await Promise.all([
      this.prisma.outreachBreaker.findMany({
        where: { workspaceId: tenant.workspaceId },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.outreachHealthEvent.findMany({
        where: { workspaceId: tenant.workspaceId },
        orderBy: { detectedAt: 'desc' },
        take: 50,
      }),
    ]);
    return { breakers, events };
  }

  private async openBreaker(
    workspaceId: string,
    scope: BreakerScope,
    scopeRef: string,
    metric: string,
    value: number,
    options: { threshold: number; windowMinutes: number; detail: Prisma.InputJsonValue; now: Date },
  ): Promise<boolean> {
    const existing = await this.prisma.outreachBreaker.findUnique({
      where: { workspaceId_scope_scopeRef: { workspaceId, scope, scopeRef } },
    });
    if (existing?.state === 'OPEN') return false;
    await this.prisma.outreachBreaker.upsert({
      where: { workspaceId_scope_scopeRef: { workspaceId, scope, scopeRef } },
      create: {
        workspaceId,
        scope,
        scopeRef,
        state: 'OPEN',
        reason: metric,
        detail: options.detail,
        openedAt: options.now,
      },
      update: {
        state: 'OPEN',
        reason: metric,
        detail: options.detail,
        openedAt: options.now,
        halfOpenAt: null,
        resolvedAt: null,
        resolvedBy: null,
      },
    });
    await this.prisma.outreachHealthEvent.create({
      data: {
        workspaceId,
        scope,
        scopeRef,
        metric,
        windowMinutes: options.windowMinutes,
        value,
        threshold: options.threshold,
        action: 'PAUSE',
        detail: options.detail,
      },
    });
    return true;
  }

  private async getBreaker(tenant: OutreachTenant, scope: BreakerScope, scopeRef: string) {
    const breaker = await this.prisma.outreachBreaker.findUnique({
      where: { workspaceId_scope_scopeRef: { workspaceId: tenant.workspaceId, scope, scopeRef } },
    });
    if (!breaker) notFound();
    return breaker;
  }

  private async recordEvent(
    tenant: OutreachTenant,
    scope: BreakerScope,
    scopeRef: string,
    action: 'RECOVER' | 'CLOSE',
    note: string,
    now: Date,
  ): Promise<void> {
    await this.prisma.outreachHealthEvent.create({
      data: {
        workspaceId: tenant.workspaceId,
        scope,
        scopeRef,
        metric: 'MANUAL',
        windowMinutes: 0,
        value: 0,
        threshold: 0,
        action,
        detail: { note },
        detectedAt: now,
        resolvedAt: action === 'CLOSE' ? now : null,
        resolvedBy: tenant.userId,
      },
    });
  }

  private normalizeScope(scope: string): BreakerScope {
    if (!(SCOPES as readonly string[]).includes(scope)) invalid('scope 必须是 mailbox/domain/workspace');
    return scope as BreakerScope;
  }

  private normalizeRef(scopeRef: string): string {
    const ref = typeof scopeRef === 'string' ? scopeRef.trim().toLowerCase() : '';
    if (!ref || ref.length > 128) invalid('scopeRef 不合法');
    return ref;
  }
}

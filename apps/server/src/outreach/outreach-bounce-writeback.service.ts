import { Inject, Injectable, Logger } from '@nestjs/common';
import { EngineHttp } from '../bff/engine-http.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { AppConfig } from '../config/configuration.js';
import { APP_CONFIG } from '../shared/config.module.js';
import type { OutreachTenant } from './outreach-consent.service.js';

export type BounceEvent = 'hard_bounce' | 'soft_bounce';

export interface BounceWritebackInput {
  contactPointId: string;
  event: BounceEvent;
  messageId: string;
  smtpCode?: string | null;
  receivedAt?: Date;
}

const MAX_ATTEMPTS = 5;
const DRAIN_BATCH = 25;

/**
 * 退信回写队列（缺口 3 P2）：把 SaaS 观测到的退信（SMTP 5xx 硬拒 / DSN 退信）
 * 回写引擎 `POST /contact-points/{pointId}/bounce-events`，让引擎的四态账本
 * 从真实退信中学习（hard → INVALID 粘滞；soft ×3 → UNKNOWN + 24h 重验）。
 *
 * 入队即幂等：((contactPointId, messageId)) 唯一索引吸收重复；
 * 未配置 OUTREACH_ENGINE_SERVICE_TOKEN 时入队照常、drain 跳过（不烧尝试次数）。
 */
@Injectable()
export class OutreachBounceWritebackService {
  private readonly logger = new Logger(OutreachBounceWritebackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: EngineHttp,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 检测点调用：pointId 缺失（legacy 草稿/DSN 无法归因）直接丢弃并计数，不落队。 */
  async enqueue(tenant: OutreachTenant, input: BounceWritebackInput): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.contactPointId)) {
      return;
    }
    const messageId = input.messageId.slice(0, 256);
    if (!messageId) return;
    await this.prisma
      .withWorkspace(tenant.workspaceId, (tx) =>
        tx.outreachBounceWriteback.create({
          data: {
            workspaceId: tenant.workspaceId,
            contactPointId: input.contactPointId,
            event: input.event,
            messageId,
            smtpCode: input.smtpCode?.slice(0, 64) ?? null,
            receivedAt: input.receivedAt ?? new Date(),
          },
        }),
      )
      .catch(() => undefined); // 唯一索引吸收重复入队；队列故障不阻塞发送主链路
  }

  /** worker tick：经 SECURITY DEFINER FOR UPDATE SKIP LOCKED 抢占 PENDING 避免多副本重复回写。 */
  async drain(): Promise<{ done: number; failed: number; skipped: number }> {
    if (!this.config.OUTREACH_ENGINE_SERVICE_TOKEN) return { done: 0, failed: 0, skipped: 0 };
    const rawRows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        workspace_id: string;
        contact_point_id: string;
        event: string;
        message_id: string;
        smtp_code: string | null;
        received_at: Date;
        attempts: number;
      }>
    >`SELECT id, workspace_id, contact_point_id, event, message_id, smtp_code, received_at, attempts
      FROM public.app_list_pending_bounce_writebacks(${DRAIN_BATCH}::integer, ${MAX_ATTEMPTS}::integer)`;
    const rows = rawRows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      contactPointId: row.contact_point_id,
      event: row.event,
      messageId: row.message_id,
      smtpCode: row.smtp_code,
      receivedAt: row.received_at,
      attempts: row.attempts,
    }));
    let done = 0;
    let failed = 0;
    let skipped = 0;
    for (const row of rows) {
      const tenant = {
        userId: 'system:bounce-writeback',
        workspaceId: row.workspaceId,
        role: 'member',
      } as OutreachTenant;
      try {
        const result = await this.engine.call(tenant, 'POST', `/contact-points/${row.contactPointId}/bounce-events`, {
          body: {
            workspaceId: row.workspaceId,
            event: row.event,
            messageId: row.messageId,
            ...(row.smtpCode ? { smtpCode: row.smtpCode } : {}),
            receivedAt: row.receivedAt.toISOString(),
          },
          headers: { 'x-service-token': this.config.OUTREACH_ENGINE_SERVICE_TOKEN! },
          timeoutMs: 10_000,
        });
        if (result.status >= 400) {
          // 404 CONTACT_POINT_NOT_FOUND（联系点被删）属永久失败，不再重试
          const permanent = result.status === 404 || result.status === 409;
          throw Object.assign(new Error(`引擎回写失败（HTTP ${result.status}）`), { permanent });
        }
        done += 1;
        await this.prisma.withWorkspace(row.workspaceId, (tx) =>
          tx.outreachBounceWriteback.update({
            where: { id: row.id },
            data: { status: 'DONE', lastError: null },
          }),
        );
      } catch (error) {
        const permanent = (error as { permanent?: boolean }).permanent === true;
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
        const attempts = row.attempts + 1;
        const terminal = permanent || attempts >= MAX_ATTEMPTS;
        await this.prisma.withWorkspace(row.workspaceId, (tx) =>
          tx.outreachBounceWriteback.update({
            where: { id: row.id },
            data: { status: terminal ? 'FAILED' : 'PENDING', attempts, lastError: message },
          }),
        );
        if (terminal) {
          this.logger.warn(`退信回写终结失败 point=${row.contactPointId} msg=${row.messageId}: ${message}`);
          failed += 1;
        } else {
          skipped += 1;
        }
      }
    }
    return { done, failed, skipped };
  }
}

import { Controller, Delete, Get, Inject, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { AppConfig } from '../config/configuration.js';
import { APP_CONFIG } from '../shared/config.module.js';
import { LEGACY_WORKSPACE_QUOTA_ALERT_TYPES, legacyWorkspaceQuotaAlertsEnabled } from '../shared/legacy-workspace-quota-alerts.js';
import { PrismaService } from '../shared/prisma.service.js';
import { TenantGuard } from './tenant.guard.js';

function linkFor(type: string, refId: string | null): string | undefined {
  // P5：不依赖 refId 的类型先判，避免 refId 为空时被上面的 run 兜底吞掉。
  if (type === 'SanctionsHoldDetected') return '/leads?queue=sanctions_hold';
  if (type.startsWith('WorkspaceQuota')) return '/settings';
  if (!refId) return type.startsWith('DiscoveryRun') ? '/find-buyers' : undefined;
  if (type.startsWith('DiscoveryRun')) return `/runs/${refId}`;
  if (type === 'LeadQualified') return '/leads?queue=recommended';
  if (type.startsWith('Claim')) return '/companies';
  return undefined;
}

/** 站内通知中心(PRD §14.4):只读列表 + 已读/删除，不承载业务判断。 */
@Controller('api/notifications')
@UseGuards(TenantGuard)
export class NotificationsController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private visibleNotifications(workspaceId: string): Prisma.NotificationWhereInput {
    return legacyWorkspaceQuotaAlertsEnabled(this.config)
      ? { workspaceId }
      : { workspaceId, type: { notIn: [...LEGACY_WORKSPACE_QUOTA_ALERT_TYPES] } };
  }

  @Get()
  async list(@Req() req: Request) {
    const tenant = req.tenant!;
    const visible = this.visibleNotifications(tenant.workspaceId);
    const { rows, unreadCount } = await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
      const items = await tx.notification.findMany({
        where: visible,
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      const count = await tx.notification.count({
        where: { ...visible, readAt: null },
      });
      return { rows: items, unreadCount: count };
    });
    return {
      data: {
        unreadCount,
        items: rows.map((row) => ({
          id: row.id,
          type: row.type,
          refId: row.refId,
          title: row.title,
          titleEn: row.titleEn,
          readAt: row.readAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          link: linkFor(row.type, row.refId),
        })),
      },
    };
  }

  @Post('read-all')
  async readAll(@Req() req: Request) {
    const tenant = req.tenant!;
    const result = await this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
      tx.notification.updateMany({
        where: { ...this.visibleNotifications(tenant.workspaceId), readAt: null },
        data: { readAt: new Date() },
      }),
    );
    return { data: { updated: result.count } };
  }

  @Post(':notificationId/read')
  async read(@Req() req: Request, @Param('notificationId') notificationId: string) {
    const tenant = req.tenant!;
    await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
      const result = await tx.notification.updateMany({
        where: { id: notificationId, workspaceId: tenant.workspaceId, readAt: null },
        data: { readAt: new Date() },
      });
      if (result.count === 0) {
        const exists = await tx.notification.findFirst({
          where: { id: notificationId, workspaceId: tenant.workspaceId },
          select: { id: true },
        });
        if (!exists) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'notification not found' } });
      }
    });
    return { data: { ok: true } };
  }

  @Delete(':notificationId')
  async remove(@Req() req: Request, @Param('notificationId') notificationId: string) {
    const tenant = req.tenant!;
    const result = await this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
      tx.notification.deleteMany({
        where: { id: notificationId, workspaceId: tenant.workspaceId },
      }),
    );
    if (result.count === 0) {
      throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'notification not found' } });
    }
    return { data: { ok: true } };
  }
}

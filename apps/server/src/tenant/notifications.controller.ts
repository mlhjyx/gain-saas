import { Controller, Delete, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../shared/prisma.service.js';
import { TenantGuard } from './tenant.guard.js';

function linkFor(type: string, refId: string | null): string | undefined {
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
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Req() req: Request) {
    const tenant = req.tenant!;
    const rows = await this.prisma.notification.findMany({
      where: { workspaceId: tenant.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const unreadCount = await this.prisma.notification.count({
      where: { workspaceId: tenant.workspaceId, readAt: null },
    });
    return {
      data: {
        unreadCount,
        items: rows.map((row) => ({
          id: row.id,
          type: row.type,
          refId: row.refId,
          title: row.title,
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
    const result = await this.prisma.notification.updateMany({
      where: { workspaceId: tenant.workspaceId, readAt: null },
      data: { readAt: new Date() },
    });
    return { data: { updated: result.count } };
  }

  @Post(':notificationId/read')
  async read(@Req() req: Request, @Param('notificationId') notificationId: string) {
    const tenant = req.tenant!;
    const result = await this.prisma.notification.updateMany({
      where: { id: notificationId, workspaceId: tenant.workspaceId, readAt: null },
      data: { readAt: new Date() },
    });
    if (result.count === 0) {
      const exists = await this.prisma.notification.findFirst({
        where: { id: notificationId, workspaceId: tenant.workspaceId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'notification not found' } });
    }
    return { data: { ok: true } };
  }

  @Delete(':notificationId')
  async remove(@Req() req: Request, @Param('notificationId') notificationId: string) {
    const tenant = req.tenant!;
    const result = await this.prisma.notification.deleteMany({
      where: { id: notificationId, workspaceId: tenant.workspaceId },
    });
    if (result.count === 0) {
      throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'notification not found' } });
    }
    return { data: { ok: true } };
  }
}

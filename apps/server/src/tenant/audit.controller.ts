import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../shared/prisma.service.js';
import { AdminGuard } from './admin.guard.js';
import { TenantGuard } from './tenant.guard.js';

/**
 * 租户自查审计(PRD 设置页:审计,仅 admin)。
 * audit_log 没有 workspace_id 列,为避免跨租户泄露,这里只返回当前操作者本人的 tenant 审计。
 */
@Controller('api/audit')
@UseGuards(TenantGuard, AdminGuard)
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Req() req: Request, @Query('limit') limit?: string) {
    const tenant = req.tenant!;
    const take = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const entries = await this.prisma.auditLog.findMany({
      where: { realm: 'tenant', actorId: tenant.userId },
      orderBy: { at: 'desc' },
      take,
    });
    return { data: { entries: entries.map((entry) => ({ ...entry, at: entry.at.toISOString() })) } };
  }
}

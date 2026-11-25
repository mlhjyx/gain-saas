import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { PrismaService } from '../shared/prisma.service.js';
import { AdminGuard } from './admin.guard.js';
import { TenantGuard } from './tenant.guard.js';

/** 游标：base64url(at ISO|id)，避免把 uuid 直接暴露给前端分页参数。 */
function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw?: string): { at: Date; id: string } | null {
  if (!raw) return null;
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    const sep = text.lastIndexOf('|');
    if (sep <= 0) return null;
    const at = new Date(text.slice(0, sep));
    const id = text.slice(sep + 1);
    if (Number.isNaN(at.getTime()) || !id) return null;
    return { at, id };
  } catch {
    return null;
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseFrom(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseTo(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(DATE_ONLY.test(value) ? `${value}T23:59:59.999Z` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 租户自查审计(PRD 设置页:审计,仅 admin)。
 * 按 workspaceId 隔离，只返回当前工作空间的 tenant 审计日志。
 * P5b-13：支持 action / from / to 过滤与游标分页（at+id 复合键，倒序），返回 total 与 nextCursor。
 */
@Controller('api/audit')
@UseGuards(TenantGuard, AdminGuard)
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Req() req: Request,
    @Query('limit') limit?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
  ) {
    const tenant = req.tenant!;
    const take = Math.min(Math.max(Number(limit) || 100, 1), 200);

    const where: Prisma.AuditLogWhereInput = {
      realm: 'tenant',
      workspaceId: tenant.workspaceId,
    };
    const actionFilter = action?.trim();
    if (actionFilter) where.action = actionFilter;

    const at: Prisma.DateTimeFilter = {};
    const fromDate = parseFrom(from);
    const toDate = parseTo(to);
    if (fromDate) at.gte = fromDate;
    if (toDate) at.lte = toDate;
    if (Object.keys(at).length > 0) where.at = at;

    const decoded = decodeCursor(cursor);
    if (decoded) {
      where.OR = [
        { at: { lt: decoded.at } },
        { at: decoded.at, id: { lt: decoded.id } },
      ];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        take: take + 1,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    const hasMore = rows.length > take;
    const entries = hasMore ? rows.slice(0, take) : rows;
    const last = entries.at(-1);
    return {
      data: {
        entries: entries.map((entry) => ({
          ...entry,
          at: entry.at.toISOString(),
        })),
        nextCursor: hasMore && last ? encodeCursor(last.at, last.id) : null,
        total,
      },
    };
  }
}

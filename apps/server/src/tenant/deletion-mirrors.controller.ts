import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { PrismaService } from '../shared/prisma.service.js';
import { AdminGuard } from './admin.guard.js';
import { TenantGuard } from './tenant.guard.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const STATUS_RE = /^[A-Z0-9_-]{1,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw?: string): { at: Date; id: string } | null {
  if (raw === undefined || raw.trim() === '') return null;
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    const sep = text.lastIndexOf('|');
    if (sep <= 0) return null;
    const at = new Date(text.slice(0, sep));
    const id = text.slice(sep + 1);
    if (Number.isNaN(at.getTime()) || !UUID_RE.test(id)) return null;
    return { at, id };
  } catch {
    return null;
  }
}

function parseLimit(raw?: string): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_LIMIT;
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 1) {
    throw new BadRequestException({
      error: { code: 'VALIDATION_ERROR', message: 'limit 必须是正整数' },
    });
  }
  return Math.min(num, MAX_LIMIT);
}

function parseStatus(raw?: string): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const normalized = raw.trim().toUpperCase();
  if (!STATUS_RE.test(normalized)) {
    throw new BadRequestException({
      error: { code: 'VALIDATION_ERROR', message: 'status 格式无效' },
    });
  }
  return normalized;
}

export interface DeletionMirrorReceipt {
  id: string;
  engineRequestId: string;
  status: string;
  saasDeleted: number;
  at: string;
}

/**
 * DSR 级联清理回执只读视图（仅管理员）：
 * - 严格通过 `prisma.withWorkspace(workspaceId)` 注入 PG FORCE RLS 上下文；
 * - 显式投影白名单字段（id / engineRequestId / status / saasDeleted / at），
 *   绝不暴露内部 token、密文、workspaceId 或任何个人数据。
 */
@Controller('api/deletion-mirrors')
@UseGuards(TenantGuard, AdminGuard)
export class DeletionMirrorsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Req() req: Request,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
  ): Promise<{
    data: {
      items: DeletionMirrorReceipt[];
      nextCursor: string | null;
      hasMore: boolean;
      total: number;
    };
  }> {
    const tenant = req.tenant!;
    const take = parseLimit(limit);
    const statusFilter = parseStatus(status);
    const hasCursor = cursor !== undefined && cursor.trim() !== '';
    const decodedCursor = hasCursor ? decodeCursor(cursor) : null;
    if (hasCursor && !decodedCursor) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'cursor 格式无效' },
      });
    }

    const baseWhere: Prisma.DeletionMirrorWhereInput = {
      workspaceId: tenant.workspaceId,
      ...(statusFilter ? { status: statusFilter } : {}),
    };
    const listWhere: Prisma.DeletionMirrorWhereInput = decodedCursor
      ? {
          ...baseWhere,
          OR: [
            { at: { lt: decodedCursor.at } },
            { at: decodedCursor.at, id: { lt: decodedCursor.id } },
          ],
        }
      : baseWhere;

    const { rows, total } = await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
      const [found, count] = await Promise.all([
        tx.deletionMirror.findMany({
          where: listWhere,
          orderBy: [{ at: 'desc' }, { id: 'desc' }],
          take: take + 1,
          select: {
            id: true,
            engineRequestId: true,
            status: true,
            saasDeleted: true,
            at: true,
          },
        }),
        tx.deletionMirror.count({ where: baseWhere }),
      ]);
      return { rows: found, total: count };
    });

    const hasMore = rows.length > take;
    const entries = hasMore ? rows.slice(0, take) : rows;
    const last = entries.at(-1);

    return {
      data: {
        items: entries.map((row) => ({
          id: row.id,
          engineRequestId: row.engineRequestId,
          status: row.status,
          saasDeleted: row.saasDeleted,
          at: row.at.toISOString(),
        })),
        nextCursor: hasMore && last ? encodeCursor(last.at, last.id) : null,
        hasMore,
        total,
      },
    };
  }
}

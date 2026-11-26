import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import type { AppConfig } from '../config/configuration.js';
import { AuditService } from '../shared/audit.service.js';
import { APP_CONFIG } from '../shared/config.module.js';
import { PrismaService } from '../shared/prisma.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

const RequestOffboardingBodySchema = z
  .object({
    confirmName: z.string().trim().min(1).max(200).optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export interface OffboardingActor {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: string;
}

export interface WorkspaceOffboardingDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly status: string;
  readonly requestedBy: string;
  readonly reason: string | null;
  readonly requestedAt: string;
  readonly coolOffEndsAt: string;
  readonly cancelledBy: string | null;
  readonly cancelledAt: string | null;
  readonly purgedBy: string | null;
  readonly purgedAt: string | null;
  readonly canCancel: boolean;
  readonly remainingDays: number;
}

interface OffboardingRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly status: string;
  readonly requestedBy: string;
  readonly reason: string | null;
  readonly requestedAt: Date;
  readonly coolOffEndsAt: Date;
  readonly cancelledBy: string | null;
  readonly cancelledAt: Date | null;
  readonly purgedBy: string | null;
  readonly purgedAt: Date | null;
}

function serializeOffboarding(row: OffboardingRow, now: Date): WorkspaceOffboardingDto {
  const remainingMs = row.coolOffEndsAt.getTime() - now.getTime();
  const canCancel = row.status === 'SCHEDULED' && remainingMs > 0;
  const remainingDays = canCancel ? Math.ceil(remainingMs / DAY_MS) : 0;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    status: row.status,
    requestedBy: row.requestedBy,
    reason: row.reason,
    requestedAt: row.requestedAt.toISOString(),
    coolOffEndsAt: row.coolOffEndsAt.toISOString(),
    cancelledBy: row.cancelledBy,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    purgedBy: row.purgedBy,
    purgedAt: row.purgedAt ? row.purgedAt.toISOString() : null,
    canCancel,
    remainingDays,
  };
}

/**
 * 租户工作空间离网注销服务（MT-P1）：
 * - 管理员输入工作空间名称确认后发起离网注销，进入 7 天冷却期（可配置）。
 * - 冷却期内管理员可自助撤回；到期后由运营侧触发整空间物理清理（POST /api/ops/workspaces/:id/purge）。
 */
@Injectable()
export class WorkspaceOffboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async getStatus(
    tenant: OffboardingActor,
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<WorkspaceOffboardingDto | null> {
    this.assertUuid(workspaceId);
    const row = await this.prisma.withWorkspace(workspaceId, async (tx) => {
      const membership = await tx.membership.findFirst({
        where: { userId: tenant.userId, workspaceId, status: 'active' },
        include: { workspace: { select: { id: true, name: true, status: true } } },
      });
      if (!membership) {
        throw new NotFoundException({ error: { code: 'NOT_A_MEMBER', message: '你不属于该工作空间' } });
      }
      return tx.workspaceOffboardingRequest.findFirst({
        where: { workspaceId },
        orderBy: { requestedAt: 'desc' },
      });
    });
    return row ? serializeOffboarding(row, now) : null;
  }

  async requestOffboarding(
    tenant: OffboardingActor,
    workspaceId: string,
    body: unknown,
    now: Date = new Date(),
  ): Promise<WorkspaceOffboardingDto> {
    this.assertUuid(workspaceId);
    const parsed = RequestOffboardingBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: '离网注销参数不合法' },
      });
    }

    const coolOffDays = this.config.WORKSPACE_OFFBOARDING_COOL_OFF_DAYS ?? 7;
    const coolOffEndsAt = new Date(now.getTime() + coolOffDays * DAY_MS);

    const created = await this.prisma.withWorkspace(workspaceId, async (tx) => {
      const membership = await tx.membership.findFirst({
        where: { userId: tenant.userId, workspaceId, status: 'active' },
        include: { workspace: { select: { id: true, name: true, status: true } } },
      });
      if (!membership) {
        throw new NotFoundException({ error: { code: 'NOT_A_MEMBER', message: '你不属于该工作空间' } });
      }
      if (membership.workspace.status !== 'ACTIVE') {
        throw new ForbiddenException({
          error: { code: 'WORKSPACE_DISABLED', message: '该工作空间已停用或归档，无法提交注销申请' },
        });
      }
      if (membership.role !== 'admin') {
        throw new ForbiddenException({
          error: { code: 'FORBIDDEN', message: '只有工作空间管理员可以提交离网注销申请' },
        });
      }

      const existing = await tx.workspaceOffboardingRequest.findFirst({
        where: { workspaceId, status: 'SCHEDULED' },
        orderBy: { requestedAt: 'desc' },
      });
      if (existing) {
        throw new ConflictException({
          error: {
            code: 'OFFBOARDING_ALREADY_SCHEDULED',
            message: '该工作空间已存在生效中的离网注销申请',
          },
        });
      }

      const expectedName = membership.workspace.name.trim();
      const confirmName = parsed.data.confirmName?.trim() ?? '';
      if (!confirmName || confirmName !== expectedName) {
        throw new BadRequestException({
          error: {
            code: 'CONFIRM_NAME_MISMATCH',
            message: '请准确输入当前工作空间名称以确认离网注销',
          },
        });
      }

      const reason = parsed.data.reason?.trim() || null;
      return tx.workspaceOffboardingRequest.create({
        data: {
          workspaceId,
          status: 'SCHEDULED',
          requestedBy: tenant.userId,
          reason,
          requestedAt: now,
          coolOffEndsAt,
        },
      });
    });

    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      workspaceId,
      action: 'workspaces.offboarding.request',
      target: created.id,
      detail: {
        coolOffDays,
        coolOffEndsAt: coolOffEndsAt.toISOString(),
      },
    });

    return serializeOffboarding(created, now);
  }

  async cancelOffboarding(
    tenant: OffboardingActor,
    workspaceId: string,
    now: Date = new Date(),
  ): Promise<WorkspaceOffboardingDto> {
    this.assertUuid(workspaceId);
    const updated = await this.prisma.withWorkspace(workspaceId, async (tx) => {
      const membership = await tx.membership.findFirst({
        where: { userId: tenant.userId, workspaceId, status: 'active' },
        include: { workspace: { select: { id: true, name: true, status: true } } },
      });
      if (!membership) {
        throw new NotFoundException({ error: { code: 'NOT_A_MEMBER', message: '你不属于该工作空间' } });
      }
      if (membership.role !== 'admin') {
        throw new ForbiddenException({
          error: { code: 'FORBIDDEN', message: '只有工作空间管理员可以撤销离网注销申请' },
        });
      }

      const existing = await tx.workspaceOffboardingRequest.findFirst({
        where: { workspaceId, status: 'SCHEDULED' },
        orderBy: { requestedAt: 'desc' },
      });
      if (!existing) {
        throw new NotFoundException({
          error: { code: 'OFFBOARDING_NOT_FOUND', message: '没有处于冷却期中的离网注销申请' },
        });
      }
      if (existing.coolOffEndsAt.getTime() <= now.getTime()) {
        throw new ConflictException({
          error: {
            code: 'OFFBOARDING_COOL_OFF_EXPIRED',
            message: '7 天冷却期已结束，无法自助撤销，请联系平台运营',
          },
        });
      }

      return tx.workspaceOffboardingRequest.update({
        where: { id: existing.id },
        data: {
          status: 'CANCELLED',
          cancelledBy: tenant.userId,
          cancelledAt: now,
        },
      });
    });

    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      workspaceId,
      action: 'workspaces.offboarding.cancel',
      target: updated.id,
      detail: { cancelledAt: now.toISOString() },
    });

    return serializeOffboarding(updated, now);
  }

  private assertUuid(value: string): void {
    if (!UUID_RE.test(value)) {
      throw new NotFoundException({ error: { code: 'WORKSPACE_NOT_FOUND', message: '工作空间不存在' } });
    }
  }
}

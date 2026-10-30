import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../shared/prisma.service.js';
import { AuditService } from '../shared/audit.service.js';
import { TenantGuard } from './tenant.guard.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 寻源任务引用：引擎只有 GET /discovery-runs/:runId，没有按方案列 run 的端点。
 * 这里保存 SaaS 自己发起的 run → plan/ICP 对应关系，关闭页面或换设备后仍能找回任务。
 * 不复制 run 状态，状态仍以引擎为准。
 */
@Controller('api/runs')
@UseGuards(TenantGuard)
export class DiscoveryRunsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Req() req: Request, @Query('icpId') icpId?: string, @Query('planId') planId?: string) {
    const tenant = req.tenant!;
    if ((!icpId && !planId) || (icpId && !UUID.test(icpId)) || (planId && !UUID.test(planId))) {
      throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: 'icpId 或 planId 必须是 UUID' } });
    }
    const rows = await this.prisma.discoveryRunLink.findMany({
      where: {
        workspaceId: tenant.workspaceId,
        ...(icpId ? { icpId } : {}),
        ...(planId ? { planId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      data: rows.map((row) => ({
        runId: row.runId,
        planId: row.planId,
        icpId: row.icpId,
        startedAt: row.createdAt.toISOString(),
      })),
    };
  }

  @Post()
  async record(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const tenant = req.tenant!;
    const { runId, planId, icpId } = body;
    if (
      typeof runId !== 'string' || !UUID.test(runId) ||
      typeof planId !== 'string' || !UUID.test(planId) ||
      typeof icpId !== 'string' || !UUID.test(icpId)
    ) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'runId、planId、icpId 必须是 UUID' },
      });
    }
    const row = await this.prisma.discoveryRunLink.upsert({
      where: { runId },
      create: { runId, workspaceId: tenant.workspaceId, planId, icpId },
      update: { planId, icpId },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'discovery.run_link.record',
      target: runId,
      detail: { planId, icpId },
    });
    return {
      data: {
        runId: row.runId,
        planId: row.planId,
        icpId: row.icpId,
        startedAt: row.createdAt.toISOString(),
      },
    };
  }
}

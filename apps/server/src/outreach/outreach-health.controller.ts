import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AdminGuard } from '../tenant/admin.guard.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { OutreachHealthService } from './outreach-health.service.js';

const decideBody = z.object({ reason: z.string().trim().min(1).max(200) });

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

/** 健康面板与熔断恢复（P4-08）：面板租户可见，评估/恢复/关闭仅管理员。 */
@Controller('api/outreach/health')
@UseGuards(TenantGuard)
export class OutreachHealthController {
  constructor(private readonly health: OutreachHealthService) {}

  @Get()
  async panel(@Req() req: Request) {
    return { data: await this.health.panel(req.tenant!) };
  }

  @Post('evaluate')
  @UseGuards(AdminGuard)
  async evaluate(@Req() req: Request) {
    return { data: await this.health.evaluateWorkspace(req.tenant!.workspaceId) };
  }

  @Post(':scope/:scopeRef/recover')
  @UseGuards(AdminGuard)
  async recover(
    @Req() req: Request,
    @Param('scope') scope: string,
    @Param('scopeRef') scopeRef: string,
    @Body() body: unknown,
  ) {
    const parsed = decideBody.safeParse(body);
    if (!parsed.success) invalid('reason 必填（根因说明）');
    return { data: await this.health.recover(req.tenant!, scope, scopeRef, parsed.data.reason) };
  }

  @Post(':scope/:scopeRef/close')
  @UseGuards(AdminGuard)
  async close(
    @Req() req: Request,
    @Param('scope') scope: string,
    @Param('scopeRef') scopeRef: string,
    @Body() body: unknown,
  ) {
    const parsed = decideBody.safeParse(body);
    if (!parsed.success) invalid('reason 必填（复核说明）');
    return { data: await this.health.close(req.tenant!, scope, scopeRef, parsed.data.reason) };
  }
}

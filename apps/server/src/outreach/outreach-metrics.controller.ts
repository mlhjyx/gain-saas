import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AdminGuard } from '../tenant/admin.guard.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { OutreachMetricsService } from './outreach-metrics.service.js';

const snapshotBody = z.object({
  windowDays: z.coerce.number().int().min(1).max(90).optional(),
});

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

/** 成本报表与指标快照（P4-09）：报表租户可见；快照写入仅管理员。 */
@Controller('api/outreach')
@UseGuards(TenantGuard)
export class OutreachMetricsController {
  constructor(private readonly metrics: OutreachMetricsService) {}

  @Get('cost-report')
  async costReport(@Req() req: Request, @Query('windowDays') windowDays?: string) {
    let days: number | undefined;
    if (windowDays !== undefined) {
      const parsed = Number(windowDays);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 90) {
        invalid('windowDays 必须是 1..90 的整数');
      }
      days = parsed;
    }
    return { data: await this.metrics.costReport(req.tenant!, days) };
  }

  @Post('metric-snapshots')
  @UseGuards(AdminGuard)
  async snapshot(@Req() req: Request, @Body() body: unknown) {
    const parsed = snapshotBody.safeParse(body ?? {});
    if (!parsed.success) invalid('windowDays 必须是 1..90 的整数');
    return { data: await this.metrics.snapshot(req.tenant!, { windowDays: parsed.data.windowDays }) };
  }
}

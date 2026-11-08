import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { OutreachWarmupService } from './outreach-warmup.service.js';

/** warmup/seed 周检查清单（P4-12 后端支撑）：运营台按域读取，判定规则见服务注释。 */
@Controller('api/outreach/warmup')
@UseGuards(TenantGuard)
export class OutreachWarmupController {
  constructor(private readonly warmup: OutreachWarmupService) {}

  @Get('checklist')
  async checklist(@Req() req: Request) {
    return { data: await this.warmup.checklist(req.tenant!) };
  }
}

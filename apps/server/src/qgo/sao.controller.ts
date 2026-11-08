import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { QgoService, type OutcomeInput } from './qgo.service.js';

/** 商机结果登记（append-only）：POST /api/saos/:id/outcomes（M2 步 10）。 */
@Controller('api/saos')
@UseGuards(TenantGuard)
export class SaoController {
  constructor(private readonly qgos: QgoService) {}

  @Post(':id/outcomes')
  async addOutcome(@Req() req: Request, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return { data: await this.qgos.addOutcome(req.tenant!, id, body as unknown as OutcomeInput) };
  }
}

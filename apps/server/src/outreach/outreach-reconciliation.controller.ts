import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { OutreachReconciliationService } from './outreach-reconciliation.service.js';

/** 发送台账日对账（P4-14）：只读报告；缺口明细供审计包与运营台消费。 */
@Controller('api/outreach/reconciliation')
@UseGuards(TenantGuard)
export class OutreachReconciliationController {
  constructor(private readonly reconciliation: OutreachReconciliationService) {}

  @Get()
  async check(@Req() req: Request, @Query('date') date?: string) {
    const day = this.reconciliation.parseDay(date);
    return { data: await this.reconciliation.reconcile(req.tenant!, day) };
  }
}

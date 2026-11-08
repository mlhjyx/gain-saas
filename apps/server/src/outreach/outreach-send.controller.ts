import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AdminGuard } from '../tenant/admin.guard.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { OutreachSendService } from './outreach-send.service.js';

/**
 * M2 步 11-3：发送执行与审计包。
 * `POST /send` 受 OUTREACH_SEND_ENABLED 门保护（默认关，返回 409 OUTREACH_SEND_DISABLED）；
 * 审计包只读，可在发送前预览。
 */
@Controller('api/outreach/batches')
@UseGuards(TenantGuard)
export class OutreachSendController {
  constructor(private readonly sends: OutreachSendService) {}

  @Post(':batchId/send')
  @UseGuards(AdminGuard)
  async send(@Req() req: Request, @Param('batchId') batchId: string) {
    return { data: await this.sends.sendBatch(req.tenant!, batchId) };
  }

  @Get(':batchId/audit-package')
  async auditPackage(@Req() req: Request, @Param('batchId') batchId: string) {
    return { data: await this.sends.getAuditPackage(req.tenant!, batchId) };
  }
}

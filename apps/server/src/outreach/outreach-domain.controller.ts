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
import { OutreachMailboxService } from './outreach-mailbox.service.js';

const verifyDnsBody = z
  .object({
    dkimSelector: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/i)
      .optional(),
  })
  .optional();

/**
 * 发信域资产与实时 DNS 核验端点（M9-PR2）：
 * - GET  /api/outreach/domains：列出工作空间全部发信域及最近一次 SPF/DKIM/DMARC/MX 核验结果；
 * - POST /api/outreach/domains/:domainId/verify-dns：按域实查 DNS 并落库核验快照（复用 #214 DNS 体检与建议引擎）。
 */
@Controller('api/outreach/domains')
@UseGuards(TenantGuard)
export class OutreachDomainController {
  constructor(private readonly mailboxes: OutreachMailboxService) {}

  @Get()
  async list(@Req() req: Request) {
    return { data: await this.mailboxes.listDomains(req.tenant!) };
  }

  @Post(':domainId/verify-dns')
  @UseGuards(AdminGuard)
  async verifyDns(
    @Req() req: Request,
    @Param('domainId') domainId: string,
    @Body() body?: unknown,
  ) {
    const parsed = verifyDnsBody.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'dkimSelector 格式不合法' },
      });
    }
    return {
      data: await this.mailboxes.verifyDomainDns(
        req.tenant!,
        domainId,
        parsed.data?.dkimSelector,
      ),
    };
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AdminGuard } from '../tenant/admin.guard.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { OutreachT1Service } from './outreach-t1.service.js';

const dnsCheckBody = z.object({
  domain: z.string().trim().min(3).max(253),
  dkimSelector: z.string().trim().min(1).max(63).optional(),
});

const sequencePlanBody = z.object({
  contactRef: z.string().uuid(),
  recipientEmail: z.string().trim().email().max(320),
  companyName: z.string().trim().max(200).optional(),
  contactName: z.string().trim().max(200).optional(),
  countryCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((v) => v.toUpperCase()),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20_000),
  rounds: z.coerce.number().int().min(2).max(4).optional(),
  startAt: z.string().datetime().optional(),
});

const attachmentBody = z.object({
  documentId: z.string().uuid(),
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(120),
  sizeBytes: z.coerce.number().int().positive(),
  status: z.string().trim().min(1).max(32),
});

const referralDraftBody = z.object({
  batchId: z.string().uuid(),
  replyId: z.string().uuid().optional(),
  sourceContactRef: z.string().uuid(),
  referredEmail: z.string().trim().email().max(320),
  companyName: z.string().trim().max(200).optional(),
  countryCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((v) => v.toUpperCase()),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20_000),
  attachments: z.array(attachmentBody).max(5).optional(),
});

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

/** Phase 3 Track 3C — T1 完整外联工作台端点（就绪态 / DNS 体检 / 2-4 轮跟进序列 / 转交联系人建稿）。 */
@Controller('api/outreach/t1')
@UseGuards(TenantGuard)
export class OutreachT1Controller {
  constructor(private readonly t1: OutreachT1Service) {}

  @Get('readiness')
  readiness() {
    return { data: this.t1.getReadiness() };
  }

  @Post('dns-check')
  async dnsCheck(@Body() body: unknown) {
    const parsed = dnsCheckBody.safeParse(body);
    if (!parsed.success) invalid('请提供合法的发信域名与可选 DKIM selector');
    return { data: await this.t1.checkDomainDns(parsed.data.domain, parsed.data.dkimSelector) };
  }

  @Get('sequences')
  async listSequences(@Req() req: Request) {
    return { data: await this.t1.listSequences(req.tenant!) };
  }

  @Post('sequences')
  @UseGuards(AdminGuard)
  async planSequence(@Req() req: Request, @Body() body: unknown) {
    const parsed = sequencePlanBody.safeParse(body);
    if (!parsed.success) invalid('自动跟进序列参数不合法（需提供合法联系人、邮箱、2 位国家代码与 2–4 轮）');
    return { data: await this.t1.planSequence(req.tenant!, parsed.data) };
  }

  @Post('referrals/draft')
  @UseGuards(AdminGuard)
  async createReferralDraft(@Req() req: Request, @Body() body: unknown) {
    const parsed = referralDraftBody.safeParse(body);
    if (!parsed.success) invalid('转交联系人建稿参数不合法');
    return { data: await this.t1.createReferralDraft(req.tenant!, parsed.data) };
  }
}

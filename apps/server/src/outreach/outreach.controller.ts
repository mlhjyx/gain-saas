import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AdminGuard } from '../tenant/admin.guard.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { OutreachConsentService } from './outreach-consent.service.js';
import { OutreachT0Service } from './outreach-t0.service.js';
import { OutreachUnsubscribeService } from './outreach-unsubscribe.service.js';

const recordConsentBody = z.object({
  contactRef: z.string().uuid(),
  status: z.enum(['OPT_IN', 'OPT_OUT', 'UNKNOWN']),
  source: z.string().trim().min(1).max(64),
  lawfulBasis: z.string().trim().min(1).max(64),
  evidence: z.unknown().optional(),
});

const eligibilityBody = z.object({
  contactRef: z.string().uuid(),
  countryCode: z.string().trim().min(2).max(3),
  email: z.string().trim().min(3).max(320),
  companyName: z.string().trim().max(200).optional(),
});

const t0CheckBody = z.object({
  leadId: z.string().uuid(),
  contactRef: z.string().uuid().nullish(),
  countryCode: z.string().trim().max(8).nullish(),
  companyName: z.string().trim().max(200).nullish(),
  contactName: z.string().trim().max(200).nullish(),
  email: z.string().trim().max(320).nullish(),
  phone: z.string().trim().max(64).nullish(),
  whatsappUrl: z.string().trim().max(500).nullish(),
  linkedinUrl: z.string().trim().max(500).nullish(),
  formUrl: z.string().trim().max(500).nullish(),
  leadStatus: z.string().trim().max(32).nullish(),
  sanctionsHold: z.boolean().optional(),
});

const t0TouchBody = z.object({
  leadId: z.string().uuid(),
  channel: z.enum(['mailto', 'linkedin', 'whatsapp', 'form']),
  target: z.string().trim().max(500).nullish(),
  note: z.string().trim().max(500).nullish(),
  outcome: z.enum(['OPENED', 'COPIED', 'SENT', 'REPLIED']).optional(),
});

const issueTokenBody = z.object({ contactRef: z.string().uuid() });

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

/** M2 步 11-1 合规底座 + Phase 1 T0 四通道轻外联门禁与留痕。 */
@Controller('api/outreach')
@UseGuards(TenantGuard)
export class OutreachController {
  constructor(
    private readonly consents: OutreachConsentService,
    private readonly unsubscribe: OutreachUnsubscribeService,
    private readonly t0: OutreachT0Service,
  ) {}

  @Post('consents')
  @UseGuards(AdminGuard)
  async recordConsent(@Req() req: Request, @Body() body: unknown) {
    const parsed = recordConsentBody.safeParse(body);
    if (!parsed.success) invalid('contactRef/status/source/lawfulBasis 不合法');
    const data = await this.consents.record(req.tenant!, parsed.data);
    return { data };
  }

  @Get('consents/:contactRef')
  async latest(@Req() req: Request, @Param('contactRef') contactRef: string) {
    const data = await this.consents.getLatest(req.tenant!, contactRef);
    return { data };
  }

  @Post('eligibility')
  async eligibility(@Req() req: Request, @Body() body: unknown) {
    const parsed = eligibilityBody.safeParse(body);
    if (!parsed.success) invalid('contactRef/countryCode/email 不合法');
    const data = await this.consents.eligibility(req.tenant!, parsed.data);
    return { data };
  }

  @Post('unsubscribe-tokens')
  @UseGuards(AdminGuard)
  async issueUnsubscribeToken(@Req() req: Request, @Body() body: unknown) {
    const parsed = issueTokenBody.safeParse(body);
    if (!parsed.success) invalid('contactRef 不合法');
    const data = await this.unsubscribe.issue(req.tenant!, parsed.data.contactRef);
    return { data };
  }

  @Post('t0/check')
  async checkT0(@Req() req: Request, @Body() body: unknown) {
    const parsed = t0CheckBody.safeParse(body);
    if (!parsed.success) invalid('T0 合规预检参数不合法');
    const data = await this.t0.check(req.tenant!, parsed.data);
    return { data };
  }

  @Post('t0/touches')
  async recordT0Touch(@Req() req: Request, @Body() body: unknown) {
    const parsed = t0TouchBody.safeParse(body);
    if (!parsed.success) invalid('轻触达留痕参数不合法');
    const data = await this.t0.recordTouch(req.tenant!, parsed.data);
    return { data };
  }

  @Get('t0/touches')
  async listT0Touches(@Req() req: Request, @Query('leadId') leadId: string) {
    if (!leadId) invalid('leadId 必填');
    const data = await this.t0.listTouches(req.tenant!, leadId);
    return { data };
  }
}

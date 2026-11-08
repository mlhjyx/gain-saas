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
import { OutreachConsentService } from './outreach-consent.service.js';
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
});

const issueTokenBody = z.object({ contactRef: z.string().uuid() });

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

/** M2 步 11-1 合规底座：同意台账 / 法域+DNC 预检 / 退订 token 签发。 */
@Controller('api/outreach')
@UseGuards(TenantGuard)
export class OutreachController {
  constructor(
    private readonly consents: OutreachConsentService,
    private readonly unsubscribe: OutreachUnsubscribeService,
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
}

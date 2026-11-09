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
import { OutreachLegalReviewsService } from './outreach-legal-reviews.service.js';
import { OutreachTemplatesService } from './outreach-templates.service.js';

const legalReviewBody = z.object({
  subjectKind: z.enum(['email_template', 'phone_script', 'consent_wording', 'lia_letter']),
  documentHash: z.string().trim().regex(/^[0-9a-fA-F]{64}$/),
  reviewerName: z.string().trim().min(1).max(200),
  reviewerFirm: z.string().trim().min(1).max(200),
  reviewedAt: z.string().datetime(),
  scope: z.string().trim().min(1).max(500),
  verdict: z.enum(['APPROVED', 'CONDITIONS', 'REJECTED']),
  conditions: z.string().trim().max(5000).optional(),
  documentRef: z.string().trim().min(1).max(256),
});

const templateBody = z.object({
  kind: z.enum(['email_first', 'email_followup', 'email_footer', 'phone_script', 'consent_wording']),
  jurisdiction: z.string().trim().regex(/^([A-Za-z]{2}|ALL)$/).optional(),
  language: z.string().trim().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
  subject: z.string().trim().max(300).optional(),
  body: z.string().trim().min(1).max(20_000),
});

const approveBody = z.object({ legalReviewId: z.string().uuid() });

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

/** 法审记录（P4-05 占位）：写入仅管理员；列表租户可见。 */
@Controller('api/outreach/legal-reviews')
@UseGuards(TenantGuard)
export class OutreachLegalReviewsController {
  constructor(private readonly reviews: OutreachLegalReviewsService) {}

  @Get()
  async list(@Req() req: Request, @Query('subjectKind') subjectKind?: string) {
    return { data: await this.reviews.list(req.tenant!, subjectKind) };
  }

  @Get(':reviewId')
  async get(@Req() req: Request, @Param('reviewId') reviewId: string) {
    return { data: await this.reviews.get(req.tenant!, reviewId) };
  }

  @Post()
  @UseGuards(AdminGuard)
  async create(@Req() req: Request, @Body() body: unknown) {
    const parsed = legalReviewBody.safeParse(body);
    if (!parsed.success) invalid('法审记录字段不合法');
    return { data: await this.reviews.create(req.tenant!, parsed.data) };
  }
}

/**
 * 模板版本化（P4-05）：新版本默认 DRAFT（不生效）；激活需绑定 APPROVED 且哈希一致的法审记录。
 * 发送/序列链路只读 ACTIVE 版本。
 */
@Controller('api/outreach/templates')
@UseGuards(TenantGuard)
export class OutreachTemplatesController {
  constructor(private readonly templates: OutreachTemplatesService) {}

  @Get()
  async list(
    @Req() req: Request,
    @Query('kind') kind?: string,
    @Query('state') state?: string,
  ) {
    return { data: await this.templates.list(req.tenant!, { kind, state }) };
  }

  @Get(':templateId')
  async get(@Req() req: Request, @Param('templateId') templateId: string) {
    return { data: await this.templates.get(req.tenant!, templateId) };
  }

  @Post()
  @UseGuards(AdminGuard)
  async create(@Req() req: Request, @Body() body: unknown) {
    const parsed = templateBody.safeParse(body);
    if (!parsed.success) invalid('模板字段不合法');
    return { data: await this.templates.create(req.tenant!, parsed.data) };
  }

  @Post(':templateId/submit-review')
  @UseGuards(AdminGuard)
  async submitReview(@Req() req: Request, @Param('templateId') templateId: string) {
    return { data: await this.templates.submitReview(req.tenant!, templateId) };
  }

  @Post(':templateId/approve')
  @UseGuards(AdminGuard)
  async approve(
    @Req() req: Request,
    @Param('templateId') templateId: string,
    @Body() body: unknown,
  ) {
    const parsed = approveBody.safeParse(body);
    if (!parsed.success) invalid('legalReviewId 必须是 UUID');
    return {
      data: await this.templates.approve(req.tenant!, templateId, parsed.data.legalReviewId),
    };
  }

  @Post(':templateId/activate')
  @UseGuards(AdminGuard)
  async activate(@Req() req: Request, @Param('templateId') templateId: string) {
    return { data: await this.templates.activate(req.tenant!, templateId) };
  }

  @Post(':templateId/retire')
  @UseGuards(AdminGuard)
  async retire(@Req() req: Request, @Param('templateId') templateId: string) {
    return { data: await this.templates.retire(req.tenant!, templateId) };
  }
}

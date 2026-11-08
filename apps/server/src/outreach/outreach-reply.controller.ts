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
import { OutreachIngestService } from './outreach-ingest.service.js';
import { OutreachReplyService } from './outreach-reply.service.js';

const replyBody = z.object({
  contactRef: z.string().uuid(),
  recipientEmail: z.string().trim().email().max(320).optional(),
  // COMPLAINT：ARF 投诉报告或人工录入，进投诉率熔断（P4-02 v1）。
  kind: z.enum(['REPLY', 'BOUNCE', 'UNSUBSCRIBE', 'COMPLAINT']).optional(),
  classification: z
    .enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'OUT_OF_OFFICE', 'UNKNOWN'])
    .optional(),
  subject: z.string().trim().max(300).optional(),
  snippet: z.string().trim().max(500).optional(),
  externalId: z.string().trim().max(256).optional(),
  receivedAt: z.string().datetime().optional(),
  saoId: z.string().uuid().optional(),
});

const ingestBody = z.object({
  /** 入站邮件原文（RFC822；≤256KB，由服务端再校验）。 */
  raw: z.string().min(1),
});

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

/** M2 步 11-4：入站回复/退信/退订回写（append-only，写后即停）。 */
@Controller('api/outreach/replies')
@UseGuards(TenantGuard)
export class OutreachReplyController {
  constructor(
    private readonly replies: OutreachReplyService,
    private readonly ingestService: OutreachIngestService,
  ) {}

  @Get()
  async list(@Req() req: Request) {
    return { data: await this.replies.list(req.tenant!) };
  }

  @Post()
  @UseGuards(AdminGuard)
  async record(@Req() req: Request, @Body() body: unknown) {
    const parsed = replyBody.safeParse(body);
    if (!parsed.success) invalid('回复字段不合法');
    return { data: await this.replies.record(req.tenant!, parsed.data) };
  }

  /**
   * 入站邮件 ingest（P4-06）：解析回复/DSN 退信/ARF 投诉，按原始 Message-ID 归因到发送台账，
   * 写 outreach_reply 并按「回复即停」语义压制（软退信只计数不压制）。IMAP 轮询走同一服务。
   */
  @Post('ingest')
  @UseGuards(AdminGuard)
  async ingest(@Req() req: Request, @Body() body: unknown) {
    const parsed = ingestBody.safeParse(body);
    if (!parsed.success) invalid('raw 必填（邮件原文）');
    return { data: await this.ingestService.ingest(req.tenant!, parsed.data.raw) };
  }
}

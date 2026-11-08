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
import { OutreachReplyService } from './outreach-reply.service.js';

const replyBody = z.object({
  contactRef: z.string().uuid(),
  recipientEmail: z.string().trim().email().max(320).optional(),
  kind: z.enum(['REPLY', 'BOUNCE', 'UNSUBSCRIBE']).optional(),
  classification: z
    .enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE', 'OUT_OF_OFFICE', 'UNKNOWN'])
    .optional(),
  subject: z.string().trim().max(300).optional(),
  snippet: z.string().trim().max(500).optional(),
  externalId: z.string().trim().max(256).optional(),
  receivedAt: z.string().datetime().optional(),
  saoId: z.string().uuid().optional(),
});

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

/** M2 步 11-4：入站回复/退信/退订回写（append-only，写后即停）。 */
@Controller('api/outreach/replies')
@UseGuards(TenantGuard)
export class OutreachReplyController {
  constructor(private readonly replies: OutreachReplyService) {}

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
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AdminGuard } from '../tenant/admin.guard.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { OutreachMailboxService } from './outreach-mailbox.service.js';

const mailboxBody = z.object({
  address: z.string().trim().email().max(320).optional(),
  displayName: z.string().trim().min(1).max(200).optional(),
  provider: z.string().trim().max(32).optional(),
  warmupStage: z.enum(['W1', 'W2', 'W3', 'MATURE']).optional(),
  dailyCap: z.coerce.number().int().min(1).max(500).optional(),
  weeklyCap: z.coerce.number().int().min(1).max(2000).optional(),
  timezone: z.string().trim().max(64).optional(),
  state: z.enum(['ACTIVE', 'PAUSED', 'RETIRED']).optional(),
});

const createMailboxBody = z.object({
  address: z.string().trim().email().max(320),
  displayName: z.string().trim().min(1).max(200),
}).merge(mailboxBody);

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

/**
 * 发件资产（P4-02）：域名/信箱/日周配额与 warmup 阶梯。
 * 列表与用量供租户查看；创建/变更仅管理员（发件身份是受控资产）。
 */
@Controller('api/outreach/mailboxes')
@UseGuards(TenantGuard)
export class OutreachMailboxController {
  constructor(private readonly mailboxes: OutreachMailboxService) {}

  @Get()
  async list(@Req() req: Request) {
    return { data: await this.mailboxes.listMailboxes(req.tenant!) };
  }

  @Get('usage')
  async usage(@Req() req: Request) {
    return { data: await this.mailboxes.summary(req.tenant!) };
  }

  @Post()
  @UseGuards(AdminGuard)
  async create(@Req() req: Request, @Body() body: unknown) {
    const parsed = createMailboxBody.safeParse(body);
    if (!parsed.success) invalid('信箱字段不合法');
    return { data: await this.mailboxes.createMailbox(req.tenant!, parsed.data) };
  }

  @Patch(':mailboxId')
  @UseGuards(AdminGuard)
  async update(
    @Req() req: Request,
    @Param('mailboxId') mailboxId: string,
    @Body() body: unknown,
  ) {
    const parsed = mailboxBody.safeParse(body);
    if (!parsed.success) invalid('信箱字段不合法');
    return { data: await this.mailboxes.updateMailbox(req.tenant!, mailboxId, parsed.data) };
  }
}

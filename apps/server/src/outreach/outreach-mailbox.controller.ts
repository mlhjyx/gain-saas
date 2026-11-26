import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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

function strictIntRangeSchema(min: number, max: number) {
  return z.union([
    z.number().int().min(min).max(max),
    z
      .string()
      .trim()
      .regex(/^[1-9]\d{0,4}$/)
      .transform((v) => Number(v))
      .refine((v) => v >= min && v <= max),
  ]);
}

const strictPortSchema = strictIntRangeSchema(1, 65535);

const mailboxBody = z.object({
  address: z.string().trim().email().max(320).optional(),
  displayName: z.string().trim().min(1).max(200).optional(),
  provider: z.string().trim().max(32).optional(),
  warmupStage: z.enum(['W1', 'W2', 'W3', 'MATURE']).optional(),
  dailyCap: strictIntRangeSchema(1, 500).optional(),
  weeklyCap: strictIntRangeSchema(1, 2000).optional(),
  timezone: z.string().trim().max(64).optional(),
  state: z.enum(['ACTIVE', 'PAUSED', 'RETIRED']).optional(),
});

const createMailboxBody = z
  .object({
    address: z.string().trim().email().max(320),
    displayName: z.string().trim().min(1).max(200),
  })
  .merge(mailboxBody);

const configureCredentialsBody = z
  .object({
    authMode: z.enum(['password', 'oauth_google', 'oauth_m365']).optional().default('password'),
    smtpHost: z.string().trim().min(1).max(253),
    smtpPort: strictPortSchema,
    smtpSecure: z.boolean().optional(),
    imapHost: z.string().trim().max(253).nullable().optional(),
    imapPort: strictPortSchema.nullable().optional(),
    imapSecure: z.boolean().optional(),
    imapMailbox: z.string().trim().min(1).max(128).optional(),
    username: z.string().trim().max(320).optional(),
    password: z.string().min(1).max(1024).optional(),
    imapUsername: z.string().trim().max(320).optional(),
    imapPassword: z.string().min(1).max(1024).optional(),
    oauthAccessToken: z.string().min(1).max(4096).optional(),
    oauthRefreshToken: z.string().min(1).max(4096).optional(),
    oauthTokenExpiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

/**
 * 发件资产与 BYO 发信箱加密托管端点（P4-02 + M9-PR2）：
 * - GET /api/outreach/mailboxes & /usage：返回脱敏元数据（绝不回显密码或密文）；
 * - POST / PATCH / DELETE & /credentials & /test-connection：仅工作空间管理员（AdminGuard）。
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

  @Post(':mailboxId/credentials')
  @UseGuards(AdminGuard)
  async configureCredentials(
    @Req() req: Request,
    @Param('mailboxId') mailboxId: string,
    @Body() body: unknown,
  ) {
    const parsed = configureCredentialsBody.safeParse(body);
    if (!parsed.success) invalid('发信箱凭据或服务器参数不合法');
    return {
      data: await this.mailboxes.configureCredentials(req.tenant!, mailboxId, parsed.data),
    };
  }

  @Delete(':mailboxId')
  @UseGuards(AdminGuard)
  async remove(@Req() req: Request, @Param('mailboxId') mailboxId: string) {
    return { data: await this.mailboxes.deleteMailbox(req.tenant!, mailboxId) };
  }

  @Post(':mailboxId/test-connection')
  @UseGuards(AdminGuard)
  async testConnection(@Req() req: Request, @Param('mailboxId') mailboxId: string) {
    return { data: await this.mailboxes.testConnection(req.tenant!, mailboxId) };
  }
}

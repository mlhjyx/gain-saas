import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminGuard } from '../tenant/admin.guard.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { OutreachOAuthService } from './outreach-oauth.service.js';

/**
 * BYO 发信箱 Google Workspace / Microsoft 365 OAuth2 授权端点：
 * - POST /api/outreach/mailboxes/:mailboxId/oauth/:provider/start（管理员发起，签发加密 CSRF state）
 * - GET  /api/outreach/oauth/:provider/callback（OAuth 提供商回跳，校验加密 state 后换取并加密落库令牌）
 */
@Controller('api/outreach')
export class OutreachOAuthController {
  constructor(private readonly oauth: OutreachOAuthService) {}

  @Post('mailboxes/:mailboxId/oauth/:provider/start')
  @UseGuards(TenantGuard, AdminGuard)
  async start(
    @Req() req: Request,
    @Param('mailboxId') mailboxId: string,
    @Param('provider') provider: string,
  ) {
    return {
      data: await this.oauth.startAuthorization(req.tenant!, mailboxId, provider),
    };
  }

  @Get('oauth/:provider/callback')
  @UseGuards(TenantGuard, AdminGuard)
  async callback(
    @Req() req: Request,
    @Param('provider') provider: string,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    return {
      data: await this.oauth.handleCallback(req.tenant!, provider, { code, state, error }),
    };
  }
}

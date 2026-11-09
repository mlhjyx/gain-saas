import {
  Body,
  UseGuards,
  CanActivate,
  Controller,
  ExecutionContext,
  Inject,
  Injectable,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { CampaignService } from './campaign.service.js';

const verifyBody = z.object({
  token: z.string().min(1),
  planHash: z.string().min(1),
  action: z.object({
    type: z.string().min(1).max(64),
    icpIds: z.array(z.string().uuid()).max(20).optional(),
    /** campaign-authz/v2（触达批次）绑定校验用。 */
    batchId: z.string().uuid().optional(),
  }),
});

/**
 * 服务身份守卫：x-service-token 与 env CAMPAIGN_INTERNAL_SERVICE_TOKEN 常量时间比对。
 * 未配置 env 时 fail-closed（503），不允许匿名验证——verify 是给引擎/M2.1 的跨服务入口。
 */
@Injectable()
export class CampaignServiceTokenGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const expected = this.config.CAMPAIGN_INTERNAL_SERVICE_TOKEN;
    if (!expected) {
      throw new ServiceUnavailableException({
        error: { code: 'CAMPAIGN_INTERNAL_NOT_CONFIGURED', message: '内部服务令牌未配置' },
      });
    }
    const req = ctx.switchToHttp().getRequest<Request>();
    const provided = req.headers['x-service-token'];
    const value = Array.isArray(provided) ? provided[0] : provided;
    if (typeof value !== 'string' || value.length === 0) {
      throw new UnauthorizedException({ error: { code: 'SERVICE_TOKEN_REQUIRED', message: '缺少服务令牌' } });
    }
    const a = Buffer.from(value, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException({ error: { code: 'SERVICE_TOKEN_INVALID', message: '服务令牌无效' } });
    }
    return true;
  }
}

/** 跨服务授权验证端点（设计文档 §6.2；引擎接入在 M2.1/步 9b）。 */
@Controller('api/internal/v1/execution-authorizations')
@UseGuards(CampaignServiceTokenGuard)
export class CampaignInternalController {
  constructor(private readonly campaigns: CampaignService) {}

  @Post('verify')
  async verify(@Body() body: unknown) {
    const parsed = verifyBody.safeParse(body);
    if (!parsed.success) {
      return { data: { valid: false, reason: 'CAMPAIGN_AUTHORIZATION_INVALID' } };
    }
    const result = await this.campaigns.verifyAuthorization(parsed.data);
    return { data: result };
  }
}

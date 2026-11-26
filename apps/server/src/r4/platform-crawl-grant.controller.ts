import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import {
  ChannelCrawlGrantRejected,
  PlatformCrawlGrantIssuer,
  type ChannelCrawlGrantRequest,
} from './platform-crawl-grant.service.js';

/**
 * 引擎平台 worker 取渠道抓取 Grant 的 mTLS 入口（P4-P3）。
 *
 * 与平台 schedule Grant 端点同一道 mTLS 门：无论 NODE_ENV 都要求客户端证书，
 * 且只接受配置的 CN（默认 `global-backend-platform-worker`）。签发默认关闭，
 * 运营显式开启（R4_CHANNEL_CRAWL_GRANT_ENABLED）后才可能成功。
 */
@Controller('api/internal/v1/platform-channel-crawl-grants')
export class PlatformCrawlGrantController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly grants: PlatformCrawlGrantIssuer,
  ) {}

  @Post()
  @HttpCode(200)
  async issue(@Body() body: Partial<Record<keyof ChannelCrawlGrantRequest, unknown>>, @Req() req: Request) {
    const socket = req.socket as {
      encrypted?: boolean;
      authorized?: boolean;
      getPeerCertificate?: () => { subject?: { CN?: string } };
    };
    const cn = socket?.encrypted === true && socket?.authorized === true
      ? socket.getPeerCertificate?.()?.subject?.CN
      : undefined;
    if (typeof cn !== 'string' || cn !== this.config.R4_PLATFORM_GRANT_CLIENT_SUBJECT) {
      throw new UnauthorizedException({
        error: { code: 'PLATFORM_GRANT_MTLS_REQUIRED', message: '需要平台 worker 的客户端证书' },
      });
    }
    if (this.config.PLATFORM_AUTHORITY_MODE === 'internal_db') {
      throw new ServiceUnavailableException({
        error: {
          code: 'PLATFORM_AUTHORITY_INTERNAL_DB_MODE',
          mode: 'internal_db',
          message: '平台权威运行在 internal_db 轻量化模式，不签发 R4 渠道抓取 Grant',
        },
      });
    }
    const required: (keyof ChannelCrawlGrantRequest)[] = [
      'channelId',
      'mode',
      'pageCap',
      'crawlRunId',
      'requestSha256',
      'technicalPolicyRevision',
      'capPerRunMicrousd',
      'campaignCapMicrousd',
    ];
    for (const key of required) {
      if (typeof body?.[key] !== 'string' || (body[key] as string).length === 0) {
        throw new BadRequestException({
          error: { code: 'PLATFORM_GRANT_REQUEST_INVALID', message: `缺少 ${key}` },
        });
      }
    }
    try {
      return await this.grants.issue(body as unknown as ChannelCrawlGrantRequest);
    } catch (error) {
      if (error instanceof ChannelCrawlGrantRejected) {
        if (
          error.code === 'PLATFORM_GRANT_BINDING_UNAVAILABLE' ||
          error.code === 'PLATFORM_GRANT_CONFIGURATION_INVALID' ||
          error.code === 'PLATFORM_CHANNEL_CRAWL_DISABLED'
        ) {
          throw new ServiceUnavailableException({ error: { code: error.code, message: error.message } });
        }
        throw new BadRequestException({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  }
}

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
import { PlatformGrantIssuer, PlatformGrantRejected, type PlatformGrantRequest } from './platform-grant.service.js';

/**
 * 引擎平台 worker 取平台运行 Grant 的 mTLS 入口（准入 v2）。
 *
 * 与机器 token 端点一样走 18448 的 mTLS 监听；这里**无论 NODE_ENV 都要求客户端证书**，
 * 且只接受配置的 CN（默认 `global-backend-platform-worker`）。普通 TLS 监听与任何
 * 无证书调用一律 401。
 */
@Controller('api/internal/v1/platform-schedule-grants')
export class PlatformGrantController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly grants: PlatformGrantIssuer,
  ) {}

  @Post()
  @HttpCode(200)
  async issue(@Body() body: Partial<Record<keyof PlatformGrantRequest, unknown>>, @Req() req: Request) {
    const cn = (req.socket as { getPeerCertificate?: () => { subject?: { CN?: string } } })
      .getPeerCertificate?.()?.subject?.CN;
    if (typeof cn !== 'string' || cn !== this.config.R4_PLATFORM_GRANT_CLIENT_SUBJECT) {
      throw new UnauthorizedException({
        error: { code: 'PLATFORM_GRANT_MTLS_REQUIRED', message: '需要平台 worker 的客户端证书' },
      });
    }
    const required: (keyof PlatformGrantRequest)[] = [
      'scheduleId',
      'purpose',
      'workflowId',
      'workflowRunId',
      'scheduleRequestSha256',
      'technicalPolicyRevision',
      'capPerRunMicrousd',
      'campaignCapMicrousd',
    ];
    for (const key of required) {
      if (typeof body?.[key] !== 'string' || (body[key] as string).length === 0)
        throw new BadRequestException({
          error: { code: 'PLATFORM_GRANT_REQUEST_INVALID', message: `缺少 ${key}` },
        });
    }
    try {
      return await this.grants.issue(body as unknown as PlatformGrantRequest);
    } catch (error) {
      if (error instanceof PlatformGrantRejected) {
        if (error.code === 'PLATFORM_GRANT_BINDING_UNAVAILABLE' || error.code === 'PLATFORM_GRANT_CONFIGURATION_INVALID')
          throw new ServiceUnavailableException({ error: { code: error.code, message: error.message } });
        throw new BadRequestException({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  }
}

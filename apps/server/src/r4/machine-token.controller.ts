import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { R4Keyring } from './r4-keyring.service.js';
import { MachineTokenService, type MachineTokenProfile } from './machine-token.service.js';

/**
 * 引擎的机器 token 入口（P2）。
 *
 * 请求体恰好 `{ profile, nonce }`（引擎侧 ≤1KB 校验）；subject 与
 * configurationRevision 由部署配置给出，不从请求体读取。
 *
 * **传输层 mTLS 尚未在此实现**：引擎以客户端证书访问，证书身份与 subject 的对齐
 * 属于 P5（恢复通道真 TLS）。在那之前本端点只在开发态可用；生产缺配置即 503。
 */
@Controller('api/internal/v1/platform-machine-tokens')
export class MachineTokenController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly keyring: R4Keyring,
    private readonly tokens: MachineTokenService,
  ) {}

  @Post()
  async issue(@Body() body: { profile?: unknown; nonce?: unknown }, @Req() req: Request) {
    if (typeof body?.profile !== 'string' || typeof body?.nonce !== 'string') {
      throw new BadRequestException({
        error: { code: 'MACHINE_TOKEN_REQUEST_INVALID', message: '需要 { profile, nonce }' },
      });
    }
    if (this.config.NODE_ENV === 'production' && !this.tlsPeerPresent(req)) {
      throw new ServiceUnavailableException({
        error: { code: 'MACHINE_TOKEN_MTLS_REQUIRED', message: '需要客户端证书（P5 前未启用）' },
      });
    }
    const subject = this.config.R4_MACHINE_SUBJECT;
    const revision = this.config.R4_MACHINE_CONFIGURATION_REVISION;
    if (!subject || !revision || !this.keyring.isAvailable('machine')) {
      throw new ServiceUnavailableException({
        error: { code: 'MACHINE_TOKEN_UNAVAILABLE', message: '机器 token 签发未配置' },
      });
    }
    try {
      return await this.tokens.issue({
        profile: body.profile as MachineTokenProfile,
        nonce: body.nonce,
        subject,
        configurationRevision: revision,
      });
    } catch (error) {
      throw new BadRequestException({
        error: {
          code: 'MACHINE_TOKEN_REQUEST_INVALID',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private tlsPeerPresent(req: Request): boolean {
    const socket = req.socket as { encrypted?: boolean; getPeerCertificate?: () => { subject?: unknown } };
    if (socket.encrypted !== true) return false;
    const cert = socket.getPeerCertificate?.();
    return Boolean(cert && cert.subject && Object.keys(cert.subject).length > 0);
  }
}

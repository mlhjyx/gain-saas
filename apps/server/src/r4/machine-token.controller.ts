import { BadRequestException, Body, Controller, ForbiddenException, HttpCode, Inject, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { R4Keyring } from './r4-keyring.service.js';
import { MachineTokenService, type MachineTokenProfile } from './machine-token.service.js';
import { assertInternalTls } from './internal-tls-only.js';

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
  @HttpCode(200)
  async issue(@Body() body: { profile?: unknown; nonce?: unknown }, @Req() req: Request) {
    if (typeof body?.profile !== 'string' || typeof body?.nonce !== 'string') {
      throw new BadRequestException({
        error: { code: 'MACHINE_TOKEN_REQUEST_INVALID', message: '需要 { profile, nonce }' },
      });
    }
    // 平台权威凭据只能经 TLS 监听口铸造；明文入口（4020/公网隧道）一律拒绝。
    assertInternalTls(req);
    const peerSubject = this.subjectFromPeer(req);
    const requireMtls =
      this.config.NODE_ENV === 'production' || this.config.R4_TLS_CLIENT_AUTH === 'required';
    if (requireMtls && !peerSubject) {
      throw new ForbiddenException({
        error: {
          code: 'MACHINE_TOKEN_MTLS_REQUIRED',
          message: '生产或 mTLS 模式下必须出示已验签的客户端证书 CN，禁止回退默认主体铸币',
        },
      });
    }
    // 引擎有三个机器身份，token 的 sub 必须与调用方证书一致（引擎会逐字比对 trust.subject）。
    const subject = peerSubject ?? this.config.R4_MACHINE_SUBJECT;
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

  /** 从已通过 TLS 校验的客户端证书 CN 推导 subject；无证书或未授权时返回 null。 */
  private subjectFromPeer(req: Request): string | null {
    const socket = req.socket as {
      authorized?: boolean;
      getPeerCertificate?: () => { subject?: { CN?: string } };
    };
    if (socket.authorized === false) return null;
    const cn = socket.getPeerCertificate?.()?.subject?.CN;
    return typeof cn === 'string' && cn.length > 0 ? cn : null;
  }
}

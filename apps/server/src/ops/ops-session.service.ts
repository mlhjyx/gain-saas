import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { hkdfSync, randomBytes } from 'node:crypto';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';

/**
 * 运营域会话(SD9 §13.2):独立 cookie、独立签名钥、独立 issuer/realm,与租户会话互不可调。
 * 只认 ops_user 表;tenant session 不能访问 /api/ops。
 */
export const OPS_SESSION_COOKIE = 'saas_ops_session';
const OPS_ISSUER = 'gain-saas:ops';
const OPS_DEV_HKDF_INFO = 'gain-saas:ops-session-dev-fallback/v1';

export interface OpsSessionClaims {
  opsUserId: string;
  jti: string;
  exp: number;
}

@Injectable()
export class OpsSessionService {
  private readonly secret: Uint8Array;
  private readonly ttlSeconds: number;
  private readonly isProduction: boolean;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly prisma: PrismaService,
  ) {
    this.isProduction = config.NODE_ENV === 'production';
    const opsSecret = config.OPS_SESSION_SECRET?.trim() ? config.OPS_SESSION_SECRET : undefined;
    if (this.isProduction) {
      if (!opsSecret || opsSecret.length < 32 || opsSecret === config.SESSION_SECRET) {
        throw new Error(
          '生产环境必须配置独立的 OPS_SESSION_SECRET（至少 32 字符，且不能与 SESSION_SECRET 相同）',
        );
      }
      this.secret = new TextEncoder().encode(opsSecret);
    } else if (opsSecret) {
      if (opsSecret === config.SESSION_SECRET) {
        throw new Error('OPS_SESSION_SECRET 不能与 SESSION_SECRET 相同');
      }
      if (opsSecret.length < 32) {
        throw new Error('OPS_SESSION_SECRET 至少 32 字符');
      }
      this.secret = new TextEncoder().encode(opsSecret);
    } else if (config.SESSION_SECRET) {
      this.secret = new Uint8Array(
        hkdfSync(
          'sha256',
          Buffer.from(config.SESSION_SECRET, 'utf8'),
          Buffer.alloc(0),
          Buffer.from(OPS_DEV_HKDF_INFO, 'utf8'),
          32,
        ),
      );
    } else {
      this.secret = randomBytes(32);
    }
    this.ttlSeconds = config.OPS_SESSION_TTL_MINUTES * 60;
  }

  async issue(opsUserId: string): Promise<{ token: string; exp: number }> {
    const jti = randomBytes(16).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    const exp = now + this.ttlSeconds;
    const token = await new SignJWT({ role: 'operator' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(OPS_ISSUER)
      .setSubject(opsUserId)
      .setJti(jti)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(this.secret);
    await this.prisma.session.create({
      data: { jti, realm: 'ops', subjectType: 'ops_user', subjectId: opsUserId, expiresAt: new Date(exp * 1000) },
    });
    return { token, exp };
  }

  async verify(token: string | undefined): Promise<OpsSessionClaims | null> {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.secret, { issuer: OPS_ISSUER });
      if (!payload.sub || payload.role !== 'operator') return null;
      const row = await this.prisma.session.findUnique({ where: { jti: String(payload.jti) } });
      if (!row || row.realm !== 'ops' || row.revokedAt || row.expiresAt.getTime() < Date.now()) return null;
      return { opsUserId: payload.sub, jti: String(payload.jti), exp: Number(payload.exp) };
    } catch {
      return null;
    }
  }

  async revoke(jti: string): Promise<void> {
    await this.prisma.session.updateMany({ where: { jti, realm: 'ops' }, data: { revokedAt: new Date() } });
  }

  clearCookieOptions() {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      path: '/',
      secure: this.isProduction,
    };
  }

  cookieOptions(maxAgeSeconds: number) {
    return {
      ...this.clearCookieOptions(),
      maxAge: maxAgeSeconds * 1000,
    };
  }

  get ttlSecondsValue(): number {
    return this.ttlSeconds;
  }
}

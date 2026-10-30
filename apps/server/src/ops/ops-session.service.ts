import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { randomBytes } from 'node:crypto';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';

/**
 * 运营域会话(SD9 §13.2):独立 cookie、独立 issuer/realm,与租户会话互不可调。
 * 只认 ops_user 表;tenant session 不能访问 /api/ops。
 */
export const OPS_SESSION_COOKIE = 'saas_ops_session';
const OPS_ISSUER = 'gain-saas:ops';

export interface OpsSessionClaims {
  opsUserId: string;
  jti: string;
  exp: number;
}

@Injectable()
export class OpsSessionService {
  private readonly secret: Uint8Array;
  private readonly ttlSeconds: number;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly prisma: PrismaService,
  ) {
    this.secret = new TextEncoder().encode(config.SESSION_SECRET);
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

  cookieOptions(maxAgeSeconds: number) {
    return { httpOnly: true, sameSite: 'lax' as const, path: '/', maxAge: maxAgeSeconds * 1000 };
  }

  get ttlSecondsValue(): number {
    return this.ttlSeconds;
  }
}

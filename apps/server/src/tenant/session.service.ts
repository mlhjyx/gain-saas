import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { randomBytes } from 'node:crypto';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import { shouldRefreshSession } from './auth.helpers.js';

/**
 * SaaS 自有会话:HS256 JWT(httpOnly cookie)+ session 行(可吊销)。
 * claims:sub(用户 id)/ wid(当前工作空间)/ role;iss 固定 gain-saas:tenant。
 * 与引擎 JWT(RS256,现铸 ≤60s)完全分离(PRD §2.3)。
 */

export const SESSION_COOKIE = 'saas_session';

export interface SessionClaims {
  userId: string;
  workspaceId: string;
  role: 'admin' | 'member';
  jti: string;
  exp: number;
}

@Injectable()
export class SessionService {
  private readonly secret: Uint8Array;
  private readonly ttlSeconds: number;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly prisma: PrismaService,
  ) {
    this.secret = new TextEncoder().encode(config.SESSION_SECRET);
    this.ttlSeconds = config.SESSION_TTL_MINUTES * 60;
  }

  async issue(userId: string, workspaceId: string, role: 'admin' | 'member'): Promise<{ token: string; claims: SessionClaims }> {
    const jti = randomBytes(16).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    const exp = now + this.ttlSeconds;
    const token = await new SignJWT({ wid: workspaceId, role })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('gain-saas:tenant')
      .setSubject(userId)
      .setJti(jti)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(this.secret);
    await this.prisma.session.create({
      data: { jti, realm: 'tenant', subjectType: 'user', subjectId: userId, expiresAt: new Date(exp * 1000) },
    });
    return { token, claims: { userId, workspaceId, role, jti, exp } };
  }

  async verify(token: string): Promise<SessionClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { issuer: 'gain-saas:tenant' });
      const role = payload.role === 'admin' ? 'admin' : payload.role === 'member' ? 'member' : null;
      if (!payload.sub || typeof payload.wid !== 'string' || !role) return null;
      // 吊销/过期检查(session 表为准,cookie 只是凭证载体)
      const row = await this.prisma.session.findUnique({ where: { jti: String(payload.jti) } });
      if (!row || row.revokedAt || row.expiresAt.getTime() < Date.now()) return null;
      return {
        userId: payload.sub,
        workspaceId: payload.wid,
        role,
        jti: String(payload.jti),
        exp: Number(payload.exp),
      };
    } catch {
      return null;
    }
  }

  async revoke(jti: string): Promise<void> {
    await this.prisma.session.updateMany({ where: { jti }, data: { revokedAt: new Date() } });
  }

  cookieOptions(maxAgeSeconds: number) {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      path: '/',
      maxAge: maxAgeSeconds * 1000,
    };
  }

  get ttl(): number {
    return this.ttlSeconds;
  }

  needsRefresh(exp: number): boolean {
    return shouldRefreshSession(exp, this.ttlSeconds);
  }
}

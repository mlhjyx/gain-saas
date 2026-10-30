import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request, Response } from 'express';
import { PrismaService } from '../shared/prisma.service.js';
import { SESSION_COOKIE, SessionService } from './session.service.js';

export interface TenantRequestContext {
  userId: string;
  workspaceId: string;
  role: 'admin' | 'member';
  jti: string;
  exp: number;
}

/** 租户域守卫:cookie 会话 → 吊销校验(session 表)→ 注入上下文 + 滑动续期。 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) {
      throw new UnauthorizedException({ error: { code: 'AUTH_REQUIRED', message: '请先登录' } });
    }
    const claims = await this.sessions.verify(token);
    if (!claims) {
      res.clearCookie(SESSION_COOKIE);
      throw new UnauthorizedException({ error: { code: 'AUTH_REQUIRED', message: '会话已过期,请重新登录' } });
    }
    // 滑动续期:剩余 < 半个 TTL 时重发(会话行保持同一 jti?否——重签新 jti 简单安全)
    if (this.sessions.needsRefresh(claims.exp)) {
      await this.sessions.revoke(claims.jti);
      const renewed = await this.sessions.issue(claims.userId, claims.workspaceId, claims.role);
      res.cookie(SESSION_COOKIE, renewed.token, this.sessions.cookieOptions(this.sessions.ttl));
      req.tenant = { ...renewed.claims };
    } else {
      req.tenant = { ...claims };
    }
    // 成员资格仍有效(被移除后立刻失效)
    const membership = await this.prisma.membership.findFirst({
      where: { userId: req.tenant.userId, workspaceId: req.tenant.workspaceId, status: 'active' },
    });
    if (!membership) {
      res.clearCookie(SESSION_COOKIE);
      throw new UnauthorizedException({ error: { code: 'NOT_A_MEMBER', message: '工作空间成员资格已失效' } });
    }
    req.tenant.role = membership.role as 'admin' | 'member';
    return true;
  }
}

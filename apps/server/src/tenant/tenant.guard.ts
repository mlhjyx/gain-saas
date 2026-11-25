import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { PrismaService } from '../shared/prisma.service.js';
import { SESSION_COOKIE, SessionService } from './session.service.js';

const ONBOARDING_ALLOWED_PREFIXES = [
  '/api/auth',
  '/api/onboarding',
  '/api/workspaces',
  '/api/workspace/context',
  '/api/notifications',
  '/api/members',
  '/api/audit',
] as const;

function resolveNormalizedPath(req: Request): string {
  const raw =
    typeof req.path === 'string' && req.path
      ? req.path
      : typeof req.originalUrl === 'string'
        ? req.originalUrl.split('?')[0]
        : '';
  return raw.replace(/\/+/g, '/');
}

export function isOnboardingAllowedPath(req: Request): boolean {
  const path = resolveNormalizedPath(req);
  return ONBOARDING_ALLOWED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

export interface TenantRequestContext {
  userId: string;
  workspaceId: string;
  role: 'admin' | 'member';
  jti: string;
  exp: number;
  /** 注册引导是否已完成(SD11)：false 时 BFF 拒绝业务请求，前端强制进入向导。 */
  onboardingCompleted: boolean;
  /** 引导建档得到的引擎 CompanyProfile id（只存引用）。 */
  onboardingCompanyId: string | null;
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
      const clearOpts = this.sessions.clearCookieOptions?.();
      if (clearOpts) res.clearCookie(SESSION_COOKIE, clearOpts);
      else res.clearCookie(SESSION_COOKIE);
      throw new UnauthorizedException({ error: { code: 'AUTH_REQUIRED', message: '会话已过期,请重新登录' } });
    }
    // 先核验成员资格与工作空间 ACTIVE 状态，再决定是否滑动续期——绝不允许停用空间或被移出成员续签新 cookie。
    const membership = await this.prisma.withWorkspace(claims.workspaceId, (tx) =>
      tx.membership.findFirst({
        where: { userId: claims.userId, workspaceId: claims.workspaceId, status: 'active' },
        include: {
          workspace: {
            select: { status: true, onboardingCompletedAt: true, onboardingCompanyId: true },
          },
        },
      }),
    );
    if (!membership) {
      const clearOpts = this.sessions.clearCookieOptions?.();
      if (clearOpts) res.clearCookie(SESSION_COOKIE, clearOpts);
      else res.clearCookie(SESSION_COOKIE);
      throw new UnauthorizedException({ error: { code: 'NOT_A_MEMBER', message: '工作空间成员资格已失效' } });
    }
    if (membership.workspace.status !== 'ACTIVE') {
      // 停用/归档：拦在所有租户请求之前（含 Grant 签发），数据保留，运营可恢复。
      throw new ForbiddenException({
        error: { code: 'WORKSPACE_DISABLED', message: '该工作空间已停用，请联系运营' },
      });
    }
    const onboardingCompleted = membership.workspace.onboardingCompletedAt !== null;
    if (!onboardingCompleted && !isOnboardingAllowedPath(req)) {
      throw new HttpException(
        {
          error: {
            code: 'ONBOARDING_INCOMPLETE',
            message: '请先完成注册引导（企业建档），再使用获客功能',
          },
        },
        409,
      );
    }
    const role = membership.role as 'admin' | 'member';
    let activeClaims = claims;
    // 滑动续期：先签新会话写 cookie 再吊销旧 jti（捕获并发续期竞态），避免同页并发请求互相踢下线。
    if (this.sessions.needsRefresh(claims.exp)) {
      const renewed = await this.sessions.issue(claims.userId, claims.workspaceId, role);
      res.cookie(SESSION_COOKIE, renewed.token, this.sessions.cookieOptions(this.sessions.ttl));
      await this.sessions.revoke(claims.jti).catch(() => undefined);
      activeClaims = renewed.claims;
    }
    req.tenant = {
      ...activeClaims,
      role,
      onboardingCompleted,
      onboardingCompanyId: membership.workspace.onboardingCompanyId ?? null,
    };
    return true;
  }
}

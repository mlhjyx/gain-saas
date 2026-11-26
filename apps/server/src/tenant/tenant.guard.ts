import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
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

/**
 * Phase 2 多模态冷启动与选国推荐：未完成引导前仅允许访问绑定到本工作空间草稿公司
 * (`onboardingCompanyId`) 的 PDF 画册上传/读取与 UN Comtrade 选国推荐路由，其余业务路由继续 409 拦截。
 * TenantGuard 与 BffGuard 共享同一份路由签名集合，避免两层守卫口径漂移。
 */
export const ONBOARDING_COMPANY_READ_ROUTES: ReadonlySet<string> = new Set([
  'GET companies/:companyId/seller-documents',
  'GET companies/:companyId/market-recommendations',
]);

export const ONBOARDING_COMPANY_ADMIN_WRITE_ROUTES: ReadonlySet<string> = new Set([
  'POST companies/:companyId/seller-documents/presign',
  'PUT companies/:companyId/seller-documents/:documentId/content',
  'POST companies/:companyId/seller-documents/:documentId/multipart/init',
  'PUT companies/:companyId/seller-documents/:documentId/parts/:partNumber',
  'POST companies/:companyId/seller-documents/:documentId/multipart/complete',
  'POST companies/:companyId/seller-documents/:documentId/commit',
  'POST companies/:companyId/seller-documents/:documentId/claim-previews',
  'POST companies/:companyId/seller-documents/:documentId/claim-drafts',
]);

function resolveNormalizedPath(req: Request): string {
  const raw =
    typeof req.path === 'string' && req.path
      ? req.path
      : typeof req.originalUrl === 'string'
        ? req.originalUrl.split('?')[0]
        : '';
  return raw.replace(/\/+/g, '/');
}

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function isSafePathParam(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

function matchOnboardingRouteSet(
  method: string,
  reqParts: readonly string[],
  signatures: ReadonlySet<string>,
  onboardingCompanyId: string,
): boolean {
  for (const sig of signatures) {
    const spaceIdx = sig.indexOf(' ');
    if (spaceIdx <= 0) continue;
    if (sig.slice(0, spaceIdx) !== method) continue;
    const templateParts = sig.slice(spaceIdx + 1).split('/');
    if (templateParts.length !== reqParts.length) continue;
    let ok = true;
    for (let i = 0; i < templateParts.length; i += 1) {
      const seg = templateParts[i];
      if (seg.startsWith(':')) {
        const decoded = decodeSegment(reqParts[i]);
        if (!isSafePathParam(decoded)) {
          ok = false;
          break;
        }
        if (seg === ':companyId' && decoded !== onboardingCompanyId) {
          ok = false;
          break;
        }
      } else if (seg !== reqParts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

export function matchOnboardingDraftCompanyRoute(
  req: Request,
  onboardingCompanyId: string | null | undefined,
): 'read' | 'admin_write' | null {
  if (!onboardingCompanyId) return null;
  const method = typeof req.method === 'string' ? req.method.toUpperCase() : '';
  if (!method) return null;
  const path = resolveNormalizedPath(req);
  if (!path.startsWith('/api/')) return null;
  const reqParts = path.slice('/api/'.length).split('/').filter(Boolean);
  if (matchOnboardingRouteSet(method, reqParts, ONBOARDING_COMPANY_READ_ROUTES, onboardingCompanyId)) {
    return 'read';
  }
  if (
    matchOnboardingRouteSet(method, reqParts, ONBOARDING_COMPANY_ADMIN_WRITE_ROUTES, onboardingCompanyId)
  ) {
    return 'admin_write';
  }
  return null;
}

export function isOnboardingAllowedPath(
  req: Request,
  onboardingCompanyId?: string | null,
): boolean {
  const path = resolveNormalizedPath(req);
  if (
    ONBOARDING_ALLOWED_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    )
  ) {
    return true;
  }
  return matchOnboardingDraftCompanyRoute(req, onboardingCompanyId) !== null;
}

export interface TenantRequestContext {
  userId: string;
  workspaceId: string;
  role: 'admin' | 'member';
  jti: string;
  exp: number;
  /** 注册建档里程碑是否已完成：不再作为全局 409 硬门禁，供工作台启航清单与执行点软引导使用。 */
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
    const onboardingCompanyId = membership.workspace.onboardingCompanyId ?? null;
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
      onboardingCompanyId,
    };
    return true;
  }
}

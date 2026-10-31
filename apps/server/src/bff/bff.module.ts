import { type CanActivate, type ExecutionContext, Injectable, Logger, Module } from '@nestjs/common';
import type { Request, Response } from 'express';
import { EngineHttp } from './engine-http.js';
import { EngineBudgetGrantService } from './engine-budget-grant.service.js';
import { BFF_ROUTES, budgetQuoteRequest, type BffRoute } from './routes.js';
import { AdminGuard } from '../tenant/admin.guard.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { ServiceModule } from '../service/service.module.js';
import { ConfigModule } from '../shared/config.module.js';
import { AuditService } from '../shared/audit.service.js';

/**
 * 动态 BFF 控制器:按路由表逐条注册到 Express。
 * 每条路由做的事只有三件(SD7 铁律 1):鉴权 → 透传(方法/路径/查询/体)→ 错误映射。
 * 变更类请求留审计(who/what,不含 body 全量,防个人数据进审计表——SD5)。
 */

function matchRoute(method: string, path: string): { route: BffRoute; params: Record<string, string> } | null {
  for (const route of BFF_ROUTES) {
    if (route.method !== method) continue;
    const saasParts = route.saasPath.split('/');
    const reqParts = path.split('/').filter(Boolean);
    if (saasParts.length !== reqParts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < saasParts.length; i += 1) {
      const seg = saasParts[i];
      if (seg.startsWith(':')) {
        params[seg.slice(1)] = decodeURIComponent(reqParts[i]);
      } else if (seg !== reqParts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

function fillParams(enginePath: string, params: Record<string, string>): string {
  return enginePath.replace(/:([A-Za-z]+)/g, (_, name: string) => encodeURIComponent(params[name] ?? ''));
}

@Injectable()
export class BffGuard implements CanActivate {
  constructor(private readonly tenantGuard: TenantGuard, private readonly adminGuard: AdminGuard) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (!(await this.tenantGuard.canActivate(ctx))) return false;
    const req = ctx.switchToHttp().getRequest<Request>();
    const matched = matchRoute(req.method, req.path.replace(/^\/api\//, ''));
    if (matched?.route.access === 'admin') {
      return this.adminGuard.canActivate(ctx);
    }
    return true;
  }
}

@Injectable()
export class BffHandler {
  private readonly logger = new Logger(BffHandler.name);

  constructor(
    private readonly engine: EngineHttp,
    private readonly budget: EngineBudgetGrantService,
    private readonly audit: AuditService,
  ) {}

  async handle(req: Request, res: Response): Promise<void> {
    const subPath = req.path.replace(/^\/api\//, '');
    const matched = matchRoute(req.method, subPath);
    if (!matched) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `没有匹配的 BFF 路由:${req.method} ${req.path}` } });
      return;
    }
    const { route, params } = matched;
    const tenant = req.tenant!;
    const query = Object.fromEntries(new URL(req.originalUrl, 'http://x').searchParams.entries());
    const body = ['POST', 'PATCH'].includes(req.method) && req.body ? req.body : undefined;
    const headers: Record<string, string> = {};
    const idempotencyKey = req.get('idempotency-key');
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    if (route.grant) {
      const quoteRequest = budgetQuoteRequest(route, params, body);
      if (!quoteRequest) {
        res.status(500).json({ error: { code: 'BFF_BUDGET_ROUTE_INVALID', message: '写路由缺少预算 quote 映射' } });
        return;
      }
      try {
        headers['x-execution-budget-grant'] = await this.budget.issue(tenant, quoteRequest);
      } catch (err) {
        this.logger.warn(`预算 Grant 签发失败(${req.method} ${req.path}): ${err instanceof Error ? err.message : String(err)}`);
        res.status(502).json(
          this.engine.toClientError(502, {
            error: { code: 'EXECUTION_BUDGET_GRANT_FAILED', message: err instanceof Error ? err.message : String(err) },
          }),
        );
        return;
      }
    }
    try {
      const result = await this.engine.call(tenant, route.method, fillParams(route.enginePath, params), {
        query,
        ...(route.csv
          ? { rawBody: typeof body === 'string' ? body : '' }
          : { body }),
        headers,
        timeoutMs: route.timeoutMs,
      });
      if (result.status >= 400) {
        // 引擎 401/403 折算 502:不能让上游授权问题触发前端「会话过期」登出
        const clientStatus = this.engine.toClientStatus(result.status, result.body);
        res.status(clientStatus).json(this.engine.toClientError(result.status, result.body));
        return;
      }
      if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
        void this.audit.record({
          realm: 'tenant',
          actorId: tenant.userId,
          action: 'bff.request',
          target: route.saasPath,
          detail: { method: req.method, workspaceId: tenant.workspaceId },
        });
      }
      if (route.raw) {
        // CSV 的 withheld 计数在引擎响应头里；BFF 必须原样转给浏览器，否则界面永远为空。
        for (const [name, value] of Object.entries(result.headers)) {
          if (name.toLowerCase().startsWith('x-report-') || name.toLowerCase() === 'content-disposition') {
            res.setHeader(name, value);
          }
        }
        res.status(result.status).type(result.contentType).send(result.body);
        return;
      }
      res.status(result.status).json(result.body);
    } catch (err) {
      // 引擎不可达:三层文案 + 技术详情(与引擎业务错误同构)
      res.status(502).json(
        this.engine.toClientError(502, { error: { code: 'MODEL_UPSTREAM_UNUSABLE', message: err instanceof Error ? err.message : String(err) } }),
      );
    }
  }
}

/**
 * Express 级注册(在 main.ts 中调用,位于 cookieParser 之后、SPA 静态之前):
 * - /api/auth、/api/members、/api/audit 由 Nest 控制器处理,跳过;
 * - 其余 /api/* 进 BFF(守卫 + 路由表);路由表之外 404;
 * - /health、/ops、/.well-known 不受影响。
 */
export function registerBffMiddleware(
  express: { use: (fn: (req: Request, res: Response, next: () => void) => void) => void },
  handler: BffHandler,
  guard: BffGuard,
): void {
  express.use(async (req: Request, res: Response, next: () => void) => {
    if (!req.path.startsWith('/api/') || req.path.startsWith('/api/auth') || req.path.startsWith('/api/members') || req.path.startsWith('/api/ops') || req.path.startsWith('/api/audit') || req.path.startsWith('/api/runs') || req.path.startsWith('/api/notifications') || req.path.startsWith('/api/workspaces') || req.path.startsWith('/api/internal/')) {
      next();
      return;
    }
    try {
      const canActivate = await guard.canActivate(
        { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ExecutionContext,
      );
      if (!canActivate) return;
    } catch (err) {
      const e = err as { getStatus?: () => number; getResponse?: () => unknown };
      const status = typeof e?.getStatus === 'function' ? e.getStatus() : 401;
      const body = typeof e?.getResponse === 'function' ? e.getResponse() : { error: { code: 'AUTH_REQUIRED', message: '请先登录' } };
      res.status(status).json(body);
      return;
    }
    await handler.handle(req, res);
  });
}

@Module({
  imports: [ConfigModule, TenantModule, ServiceModule],
  providers: [EngineHttp, EngineBudgetGrantService, BffHandler, BffGuard],
  exports: [EngineHttp, EngineBudgetGrantService, BffHandler, BffGuard],
})
export class BffModule {}

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { type CanActivate, type ExecutionContext, Inject, Injectable, Logger, Module, Optional } from '@nestjs/common';
import type { Request, Response } from 'express';
import { EngineHttp } from './engine-http.js';
import { EngineBudgetGrantService, EngineBudgetQuoteError } from './engine-budget-grant.service.js';
import {
  WorkspaceBudgetPolicyService,
  WorkspaceBudgetQuotaExceededError,
} from './workspace-budget-policy.service.js';
import { OnboardingController } from './onboarding.controller.js';
import { AcquisitionTasksController } from './acquisition-tasks.controller.js';
import { BFF_ROUTES, PLATFORM_LAWFUL_BASIS, budgetQuoteRequest, engineRequestBody, injectPlatformLawfulBasis, type BffRoute } from './routes.js';
import { AdminGuard } from '../tenant/admin.guard.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { ServiceModule } from '../service/service.module.js';
import { APP_CONFIG, ConfigModule } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { AuditService } from '../shared/audit.service.js';
import { ComplianceDeclarationService } from '../service/compliance-declaration.service.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { WalletService } from '../wallet/wallet.service.js';
import { InsufficientCreditsError, WalletFrozenError } from '../wallet/wallet.types.js';
import {
  buildBffHoldIdempotencyKey,
  extractDiscoveryRunId,
  extractSyncBillableUnits,
  resolveBffWalletAction,
} from '../wallet/bff-wallet-billing.js';
import { copyForError } from '@gain-saas/shared';

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
        // 坏的百分号编码(如 %zz)会抛 URIError,不处理会被外层当成 401
        let decoded = reqParts[i];
        try {
          decoded = decodeURIComponent(reqParts[i]);
        } catch {
          // 保留原文:引擎/校验层会按非法值拒绝
        }
        params[seg.slice(1)] = decoded;
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
    // 软化注册引导硬门禁：不再因 onboardingCompleted=false 返回 409 ONBOARDING_INCOMPLETE；
    // 身份会话、工作空间 ACTIVE 与 admin RBAC 仍由 TenantGuard + AdminGuard 严格兜底。
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
    private readonly compliance: ComplianceDeclarationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() private readonly wallet?: WalletService,
  ) {}

  async handle(req: Request, res: Response): Promise<void> {
    const subPath = req.path.replace(/^\/api\//, '');
    const tenant = req.tenant!;
    // 2026-11-04 起取消租户数据处理声明：合法依据由平台统一注入（complianceInject 路由），
    // 这里只保留只读回看——平台引用 + 本工作空间留存的历史声明；写入入口已下线。
    if (subPath === 'settings/compliance' && (req.method === 'GET' || req.method === 'PUT')) {
      if (req.method === 'GET') {
        res.status(200).json({
          data: {
            platform: PLATFORM_LAWFUL_BASIS,
            declarations: await this.compliance.history(tenant.workspaceId),
          },
        });
        return;
      }
      res.status(410).json({
        error: {
          code: 'COMPLIANCE_DECLARATION_RETIRED',
          message: 'tenant declarations are retired; the platform provides the lawful basis',
        },
      });
      return;
    }
    const matched = matchRoute(req.method, subPath);
    if (!matched) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `没有匹配的 BFF 路由:${req.method} ${req.path}` } });
      return;
    }
    const { route, params } = matched;
    // 坏 query 编码时 new URL 会抛 TypeError → 裸 500;按 400 拒绝。
    let query: Record<string, string>;
    try {
      query = Object.fromEntries(new URL(req.originalUrl, 'http://x').searchParams.entries());
    } catch {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '请求 URL 编码非法' } });
      return;
    }
    const binaryBody = route.binary ? (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)) : undefined;
    let body = ['POST', 'PATCH'].includes(req.method) && !route.binary && req.body ? req.body : undefined;
    // 联系人三路由的合法依据由平台统一注入（请求显式携带时不覆盖；2026-11-04 取消租户声明）。
    // 注入必须发生在 quote 之前——guess/verify 的 quote 绑定 body，改在后会 SCOPE_MISMATCH。
    if (route.complianceInject && req.method === 'POST') {
      body = injectPlatformLawfulBasis(body);
    }
    // 引擎镜像升级前，discover attemptId 既不能进 quote 也不能进转发体。
    // 单一能力语义（2026-11-04）：两个开关只要有一个打开，就视为引擎镜像支持 attemptId；
    // 未升级的旧镜像默认两者都关，派发前从 quote 与转发体里剥离。
    const attemptPassthroughEnabled =
      this.config.ENGINE_DISCOVER_ATTEMPT_ID_ENABLED || this.config.ENGINE_RETRY_ATTEMPT_ID_ENABLED;
    const quoteOptions = {
      discoverAttemptId: attemptPassthroughEnabled,
      writeAttemptId: attemptPassthroughEnabled,
      manufacturerNetwork: this.config.ENGINE_MANUFACTURER_NETWORK_ENABLED,
    };
    let forwardBody: unknown;
    try {
      forwardBody = engineRequestBody(route, body, quoteOptions);
    } catch (error) {
      if (!(error instanceof Error) || !['MANUFACTURER_NETWORK_REVISION_INVALID', 'MANUFACTURER_NETWORK_NOT_AVAILABLE'].includes(error.message)) throw error;
      res.status(400).json(this.engine.toClientError(400, { error: { code: error.message, message: '当前搜索配置不可用，请刷新后重试' } }, req.headers?.['accept-language'] as string | undefined));
      return;
    }
    const headers: Record<string, string> = {};
    const idempotencyKey = req.get('idempotency-key');
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

    // M9 充值钱包灰度扣费（WALLET_BILLING_ENABLED=true 时生效，默认 false）：
    // 建档与 ICP 免费；核心收费动作按「预占 → 执行 → 有效产出实扣 / 失败自动退还」闭环处理。
    const walletSpec = this.wallet?.billingEnabled
      ? resolveBffWalletAction(route.method, route.enginePath)
      : null;
    let activeHoldId: string | null = null;
    if (walletSpec && this.wallet) {
      const refId = params[walletSpec.refParam] ?? route.saasPath;
      const holdKey = buildBffHoldIdempotencyKey(walletSpec, refId, idempotencyKey, forwardBody);
      try {
        const held = await this.wallet.holdCredits(tenant.workspaceId, {
          idempotencyKey: holdKey,
          actionCode: walletSpec.actionCode,
          refType: walletSpec.refType,
          refId,
          actorId: tenant.userId,
        });
        // 仅新建的预占单才归属本次请求释放/结算；若命中幂等重放（idempotent === true），
        // 绝不得在并发或重试遇上游 409/5xx/超时时误释放原在途请求的 HELD 冻结（防 0 积分白嫖）。
        if (!held.free && !held.idempotent && held.hold) {
          activeHoldId = held.hold.id;
        }
      } catch (err) {
        const lang = req.headers?.['accept-language'] as string | undefined;
        if (err instanceof InsufficientCreditsError) {
          const copy = copyForError('INSUFFICIENT_CREDITS', lang);
          res.status(402).json({
            error: {
              code: 'INSUFFICIENT_CREDITS',
              userCopy: { title: copy.title, why: copy.why, next: copy.next },
              details: {
                availableCredits: err.availableCredits,
                requiredCredits: err.requiredCredits,
                actionCode: err.actionCode,
              },
            },
            meta: { engineCode: 'INSUFFICIENT_CREDITS', engineMessage: err.message },
          });
          return;
        }
        if (err instanceof WalletFrozenError) {
          const copy = copyForError('WALLET_FROZEN', lang);
          res.status(403).json({
            error: {
              code: 'WALLET_FROZEN',
              userCopy: { title: copy.title, why: copy.why, next: copy.next },
            },
            meta: { engineCode: 'WALLET_FROZEN', engineMessage: err.message },
          });
          return;
        }
        throw err;
      }
    }

    const releaseActiveHold = async (reason: string): Promise<void> => {
      if (!activeHoldId || !this.wallet) return;
      const holdToRelease = activeHoldId;
      activeHoldId = null;
      try {
        await this.wallet.releaseHold(tenant.workspaceId, holdToRelease, reason, tenant.userId);
      } catch (releaseErr) {
        this.logger.warn(
          `预占积分退还失败(hold=${holdToRelease}, reason=${reason}): ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`,
        );
      }
    };

    if (route.grant) {
      const quoteRequest = budgetQuoteRequest(route, params, forwardBody, quoteOptions);
      if (!quoteRequest) {
        await releaseActiveHold('BFF_BUDGET_ROUTE_INVALID');
        res.status(500).json({ error: { code: 'BFF_BUDGET_ROUTE_INVALID', message: '写路由缺少预算 quote 映射' } });
        return;
      }
      try {
        headers['x-execution-budget-grant'] = await this.budget.issue(tenant, quoteRequest);
      } catch (err) {
        await releaseActiveHold('BUDGET_GRANT_FAILED');
        if (err instanceof WorkspaceBudgetQuotaExceededError) {
          res.status(err.status).json(
            this.engine.toClientError(err.status, { error: { code: err.code, message: err.message } }, req.headers?.['accept-language'] as string | undefined),
          );
          return;
        }
        // 引擎自己的 quote 拒绝(如 QUOTE_UNAVAILABLE)保留原码,前端才能说清「这项操作还没开放
        // 预算账户」而不是笼统的「稍后重试」;网络/签名失败仍归 GRANT_FAILED。
        const quoteCode = err instanceof EngineBudgetQuoteError
          ? (err.engineBody as { error?: { code?: unknown } } | null)?.error?.code
          : undefined;
        const code =
          typeof quoteCode === 'string' && quoteCode.startsWith('EXECUTION_BUDGET_')
            ? quoteCode
            : 'EXECUTION_BUDGET_GRANT_FAILED';
        this.logger.warn(`预算 Grant 签发失败(${req.method} ${req.path}, ${code}): ${err instanceof Error ? err.message : String(err)}`);
        res.status(502).json(
          this.engine.toClientError(502, {
            error: { code, message: err instanceof Error ? err.message : String(err) },
          }, req.headers?.['accept-language'] as string | undefined),
        );
        return;
      }
    }
    if (route.stream) {
      const abortController = new AbortController();
      const onResClose = () => {
        if (!res.writableEnded) abortController.abort();
      };
      res.on?.('close', onResClose);
      try {
        const result = await this.engine.openStream(tenant, route.method, fillParams(route.enginePath, params), {
          query,
          headers,
          timeoutMs: route.timeoutMs,
          signal: abortController.signal,
        });
        if (result.status >= 400) {
          const clientStatus = this.engine.toClientStatus(result.status, result.errorBody);
          res.status(clientStatus).json(
            this.engine.toClientError(result.status, result.errorBody, req.headers?.['accept-language'] as string | undefined),
          );
          return;
        }
        res.status(result.status);
        res.setHeader(
          'Content-Type',
          result.headers.get('content-type') ?? result.contentType ?? 'application/octet-stream',
        );
        const disposition = result.headers.get('content-disposition');
        if (disposition) res.setHeader('Content-Disposition', disposition);
        const contentLength = result.headers.get('content-length');
        if (contentLength) res.setHeader('Content-Length', contentLength);
        res.setHeader('Cache-Control', result.headers.get('cache-control') ?? 'no-store');
        res.setHeader('X-Content-Type-Options', result.headers.get('x-content-type-options') ?? 'nosniff');
        if (!result.bodyStream) {
          res.end();
          return;
        }
        const nodeStream = Readable.fromWeb(result.bodyStream as unknown as NodeWebReadableStream);
        try {
          await pipeline(nodeStream, res);
        } catch (streamErr) {
          nodeStream.destroy();
          abortController.abort();
          if (res.headersSent) {
            if (!res.destroyed) res.destroy?.(streamErr instanceof Error ? streamErr : undefined);
            return;
          }
          throw streamErr;
        }
      } catch (err) {
        if (res.headersSent) {
          abortController.abort();
          if (!res.destroyed) res.destroy?.(err instanceof Error ? err : undefined);
          return;
        }
        res.status(502).json(
          this.engine.toClientError(
            502,
            { error: { code: 'MODEL_UPSTREAM_UNUSABLE', message: err instanceof Error ? err.message : String(err) } },
            req.headers?.['accept-language'] as string | undefined,
          ),
        );
      } finally {
        res.removeListener?.('close', onResClose);
      }
      return;
    }
    try {
      const result = await this.engine.call(tenant, route.method, fillParams(route.enginePath, params), {
        query,
        ...(route.binary
          ? { binaryBody, binaryContentType: req.get('content-type') ?? undefined }
          : { body: forwardBody }),
        headers,
        timeoutMs: route.timeoutMs,
      });
      if (result.status >= 400) {
        await releaseActiveHold(`DISPATCH_FAILED_HTTP_${result.status}`);
        // 引擎 401/403 折算 502:不能让上游授权问题触发前端「会话过期」登出
        const clientStatus = this.engine.toClientStatus(result.status, result.body);
        res.status(clientStatus).json(this.engine.toClientError(result.status, result.body, req.headers?.['accept-language'] as string | undefined));
        return;
      }
      if (activeHoldId && walletSpec && this.wallet) {
        try {
          if (walletSpec.mode === 'async') {
            const runId = extractDiscoveryRunId(result.body);
            if (runId) {
              await this.wallet.attachHoldRef(tenant.workspaceId, activeHoldId, runId);
            }
          } else {
            const units = extractSyncBillableUnits(walletSpec.actionCode, result.body);
            await this.wallet.settleHold(tenant.workspaceId, {
              holdId: activeHoldId,
              billableUnits: units,
              actorId: tenant.userId,
            });
          }
          activeHoldId = null;
        } catch (settleErr) {
          this.logger.warn(
            `预占积分结算/绑定失败(hold=${activeHoldId}): ${settleErr instanceof Error ? settleErr.message : String(settleErr)}`,
          );
        }
      }
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
        void this.audit.record({
          realm: 'tenant',
          actorId: tenant.userId,
          workspaceId: tenant.workspaceId,
          action: 'bff.request',
          target: route.saasPath,
          detail: { method: req.method, workspaceId: tenant.workspaceId },
        });
      }
      // EngineHttp 对非 JSON(如 CSV/二进制)返回原始 Buffer + contentType;
      // 直接 json() 会把 Buffer 序列化成 {type:"Buffer",data:[…]} 的垃圾响应。
      const contentType = result.contentType ?? 'application/json; charset=utf-8';
      if (Buffer.isBuffer(result.body) && !contentType.includes('json')) {
        res.status(result.status).type(contentType).send(result.body);
        return;
      }
      res.status(result.status).json(result.body);
    } catch (err) {
      await releaseActiveHold('ENGINE_DISPATCH_ERROR');
      // 引擎不可达:三层文案 + 技术详情(与引擎业务错误同构)
      res.status(502).json(
        this.engine.toClientError(502, { error: { code: 'MODEL_UPSTREAM_UNUSABLE', message: err instanceof Error ? err.message : String(err) } }, req.headers?.['accept-language'] as string | undefined),
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
    if (!req.path.startsWith('/api/') || req.path.startsWith('/api/auth') || req.path.startsWith('/api/members') || req.path.startsWith('/api/ops') || req.path.startsWith('/api/audit') || req.path === '/api/deletion-mirrors' || req.path.startsWith('/api/deletion-mirrors/') || req.path.startsWith('/api/runs') || req.path.startsWith('/api/notifications') || req.path.startsWith('/api/workspace') || req.path.startsWith('/api/wallet') || req.path.startsWith('/api/onboarding') || req.path.startsWith('/api/tasks') || req.path.startsWith('/api/campaigns') || req.path.startsWith('/api/qgos') || req.path.startsWith('/api/saos') || req.path.startsWith('/api/outreach') || req.path.startsWith('/api/public/outreach') || req.path.startsWith('/api/public/cooperation-intents') || req.path.startsWith('/api/internal/')) {
      next();
      return;
    }
    try {
      const canActivate = await guard.canActivate(
        { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ExecutionContext,
      );
      if (!canActivate) return;
    } catch (err) {
      // 守卫抛出的 HttpException 必须和全局过滤器同形：{error:{code,userCopy{三层}},meta}。
      // 直接 json(body) 会把 {error:{code,message}} 裸送前端，用户只看到技术码
      //（P5 验收实测 ONBOARDING_INCOMPLETE/AUTH_REQUIRED/WORKSPACE_DISABLED 均无三层文案）。
      const e = err as { getStatus?: () => number; getResponse?: () => unknown };
      const status = typeof e?.getStatus === 'function' ? e.getStatus() : 401;
      const raw = typeof e?.getResponse === 'function' ? e.getResponse() : undefined;
      const error = (raw as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
      const code = typeof error?.code === 'string' ? error.code : 'AUTH_REQUIRED';
      const copy = copyForError(code, req.headers?.['accept-language'] as string | undefined);
      res.status(status).json({
        error: { code, userCopy: { title: copy.title, why: copy.why, next: copy.next } },
        meta: { engineCode: code, engineMessage: typeof error?.message === 'string' ? error.message : '' },
      });
      return;
    }
    await handler.handle(req, res);
  });
}

@Module({
  imports: [ConfigModule, TenantModule, ServiceModule, WalletModule],
  controllers: [OnboardingController, AcquisitionTasksController],
  providers: [
    EngineHttp,
    EngineBudgetGrantService,
    WorkspaceBudgetPolicyService,
    BffHandler,
    BffGuard,
    ComplianceDeclarationService,
  ],
  exports: [EngineHttp, EngineBudgetGrantService, BffHandler, BffGuard],
})
export class BffModule {}

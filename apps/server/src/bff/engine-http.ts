import { Inject, Injectable, Logger } from '@nestjs/common';
import { copyForError, type ClientErrorBody } from '@gain-saas/shared';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import type { SaasRole } from '../service/engine-token.signer.js';
import { EngineTokenSigner } from '../service/engine-token.signer.js';
import type { TenantRequestContext } from '../tenant/tenant.guard.js';

/**
 * 引擎调用(SD7):BFF 内现铸 ≤60s RS256 token(workspace claim + 角色),调 /api/v1/*。
 * 错误一律经 packages/shared 三层文案映射为 ClientErrorBody(PRD §14.4),
 * 引擎原始码/消息放 meta(前端「技术详情」折叠)。
 */

export interface EngineCallResult {
  status: number;
  body: unknown;
  contentType: string;
  headers: Record<string, string>;
}

@Injectable()
export class EngineHttp {
  private readonly logger = new Logger(EngineHttp.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly signer: EngineTokenSigner,
  ) {}

  async call(
    tenant: Pick<TenantRequestContext, 'userId' | 'workspaceId' | 'role'>,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    enginePath: string,
    options: { query?: Record<string, string>; body?: unknown; rawBody?: string; headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<EngineCallResult> {
    const role: SaasRole = tenant.role === 'admin' ? 'saas-admin' : 'saas-member';
    const token = await this.signer.mint({
      subjectId: tenant.userId,
      workspaceId: tenant.workspaceId,
      roles: [role],
    });
    const url = new URL(`/api/v1${enginePath}`, this.config.ENGINE_ORIGIN);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }
    const hasRawBody = options.rawBody !== undefined;
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(hasRawBody
          ? { 'content-type': 'text/csv; charset=utf-8' }
          : options.body !== undefined
            ? { 'content-type': 'application/json' }
            : {}),
        ...(options.headers ?? {}),
      },
      body: hasRawBody ? options.rawBody : options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const contentType = res.headers.get('content-type') ?? 'application/json';
    const headers = Object.fromEntries(res.headers.entries());
    if (contentType.includes('application/json')) {
      return { status: res.status, body: await res.json().catch(() => ({})), contentType, headers };
    }
    // 非 JSON(周报 CSV)按原始字节透传:res.text() 按 fetch 规范吞掉 UTF-8 BOM,
    // 浏览器下载的 CSV 在 Excel 里会中文乱码。Buffer 原样交给 res.send。
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()), contentType, headers };
  }

  /** 非引擎 JWT 的服务身份调用(事件消费等),不走租户角色。 */
  async callWithToken(
    token: string,
    method: 'GET' | 'POST',
    path: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<Response> {
    const url = new URL(`/api/v1${path}`, this.config.ENGINE_ORIGIN);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }
    return fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  }

  /** 引擎错误 → 前端三层文案(PRD §14.2/§14.4;词表唯一真值在 packages/shared)。 */
  toClientError(status: number, engineBody: unknown): ClientErrorBody {
    const err = (engineBody as { error?: { code?: string; message?: string } } | null)?.error;
    const code = err?.code ?? 'UNKNOWN';
    let copy = copyForError(code);
    if (status === 401 || status === 403) {
      // 引擎对我们的服务身份说 401/403 = SaaS↔引擎授权未就绪(角色映射/JWKS 未配),
      // 绝不代表「用户会话失效」——必须给出可理解的降级说明,而不是让前端登出用户。
      copy = {
        title: '获客能力尚未完成授权对接',
        why: 'GainOS 与获客引擎的服务授权还没有配好(通常由运维在部署窗口完成),与你的账号无关。',
        next: '你的操作会保留;稍后刷新重试即可,或联系运营确认对接进度。',
      };
    }
    return {
      error: { code, userCopy: { title: copy.title, why: copy.why, next: copy.next } },
      meta: { engineCode: code, engineMessage: err?.message ?? '' },
    };
  }

  /**
   * 引擎错误码 → 对客户端的状态码。
   * 引擎 401/403 一律折算成 502(上游不可用),使前端不会把「引擎未授权」误判为「用户会话过期」而登出。
   */
  toClientStatus(engineStatus: number): number {
    if (engineStatus === 401 || engineStatus === 403) return 502;
    return engineStatus;
  }
}

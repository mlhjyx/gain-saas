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

/**
 * 引擎业务域内的 403(不是「SaaS↔引擎授权未就绪」):要求用户补一个产品前提或刷新重试,
 * 页面上应给可执行的说明,不能折算成 502 的对接未就绪文案。
 * - 联系人发现缺 lawfulBasis:引擎在消费预算前就拒绝;
 * - 执行预算 Grant 的作用域/撤销拒绝:quote 与业务请求不一致或平台已撤销。
 */
const DOMAIN_FORBIDDEN_CODES: ReadonlySet<string> = new Set([
  'CONTACT_DISCOVERY_LAWFUL_BASIS_REQUIRED',
  'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
  'EXECUTION_BUDGET_AUTHORITY_REVOKED',
]);

function engineErrorCode(engineBody: unknown): string {
  const code = (engineBody as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

/** 服务身份失败的中性双语说明；不推断唯一原因，不承诺保留/费用/不会重执行。 */
function serviceIdentityCopy(lang?: string | null) {
  if (lang && lang.toLowerCase().startsWith('en')) {
    return {
      title: 'Service authorization could not be verified',
      why: 'The request failed a service-to-service authorization check. This alone does not show that you need to sign in again or lack personal access.',
      next: 'Ask platform support to check service authorization. If an earlier execution is unconfirmed, check that operation before executing again.',
    };
  }
  return {
    title: '服务授权校验暂未通过',
    why: '当前请求的服务间授权校验未通过，不能据此判断你需要重新登录或个人无权。',
    next: '请联系平台运营检查服务授权；已有执行结果未确认时，先查询原操作，不要直接再次执行。',
  };
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
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    enginePath: string,
    options: { query?: Record<string, string>; body?: unknown; rawBody?: string; binaryBody?: Uint8Array; binaryContentType?: string; headers?: Record<string, string>; timeoutMs?: number } = {},
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
    const hasBinaryBody = options.binaryBody !== undefined;
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(hasBinaryBody
          ? { 'content-type': options.binaryContentType ?? 'application/octet-stream' }
          : hasRawBody
            ? { 'content-type': 'text/csv; charset=utf-8' }
            : options.body !== undefined
              ? { 'content-type': 'application/json' }
              : {}),
        ...(options.headers ?? {}),
      },
      body: hasBinaryBody
        ? (options.binaryBody as unknown as BodyInit)
        : hasRawBody
          ? options.rawBody
          : options.body !== undefined
            ? JSON.stringify(options.body)
            : undefined,
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
  toClientError(status: number, engineBody: unknown, lang?: string | null): ClientErrorBody {
    const err = (engineBody as { error?: { code?: string; message?: string } } | null)?.error;
    const code = err?.code ?? 'UNKNOWN';
    let copy = copyForError(code, lang);
    if ((status === 401 || status === 403) && !DOMAIN_FORBIDDEN_CODES.has(code)) {
      // 引擎对我们的服务身份说 401/403 = 服务间授权校验失败; 不推断唯一原因,
      // 也绝不代表「用户会话失效」或「个人无权」——给出中性降级说明,不让前端登出用户。
      copy = serviceIdentityCopy(lang);
    }
    return {
      error: { code, userCopy: { title: copy.title, why: copy.why, next: copy.next } },
      meta: { engineCode: code, engineMessage: err?.message ?? '' },
    };
  }

  /**
   * 引擎错误码 → 对客户端的状态码。
   * 引擎 401/403 折算成 502(上游不可用),使前端不会把「引擎未授权」误判为「用户会话过期」而登出。
   * 例外:业务域 403(见 DOMAIN_FORBIDDEN_CODES)保留为 403,让页面展示可执行的合规提示。
   */
  toClientStatus(engineStatus: number, engineBody?: unknown): number {
    if (engineStatus !== 401 && engineStatus !== 403) return engineStatus;
    if (engineBody !== undefined && DOMAIN_FORBIDDEN_CODES.has(engineErrorCode(engineBody))) {
      return engineStatus;
    }
    return 502;
  }
}

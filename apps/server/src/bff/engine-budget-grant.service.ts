import { Injectable, Logger } from '@nestjs/common';
import type { TenantRequestContext } from '../tenant/tenant.guard.js';
import {
  EngineBudgetGrantSigner,
  type WorkspaceTechnicalQuote,
} from '../service/engine-budget-grant.signer.js';
import { EngineHttp } from './engine-http.js';

/**
 * 写路由的预算授权:先取引擎 quote,再签一次性 Grant。
 *
 * 两步都在服务端完成;前端不接触签名钥,也不缓存 Grant。
 * quote 的 requestSha256 绑定"operation + 精确请求体",所以 quote 与业务请求
 * 必须使用同一份 body/路径参数(见 routes.ts 的 budgetQuoteRequest)。
 */
export class EngineBudgetQuoteError extends Error {
  constructor(
    readonly status: number,
    readonly engineBody: unknown,
  ) {
    const code = (engineBody as { error?: { code?: string } } | null)?.error?.code;
    super(`执行预算 quote 失败(HTTP ${status}${code ? ` ${code}` : ''})`);
    this.name = 'EngineBudgetQuoteError';
  }
}

@Injectable()
export class EngineBudgetGrantService {
  private readonly logger = new Logger(EngineBudgetGrantService.name);

  constructor(
    private readonly engine: EngineHttp,
    private readonly signer: EngineBudgetGrantSigner,
  ) {}

  async issue(
    tenant: Pick<TenantRequestContext, 'userId' | 'workspaceId' | 'role'>,
    quoteRequest: Record<string, unknown>,
  ): Promise<string> {
    const response = await this.engine.call(tenant, 'POST', '/execution-budget/workspace-technical-quote', {
      body: quoteRequest,
    });
    if (response.status !== 200) throw new EngineBudgetQuoteError(response.status, response.body);

    const quote = (response.body as { data?: WorkspaceTechnicalQuote } | null)?.data;
    if (!quote || typeof quote !== 'object' || typeof quote.requestSha256 !== 'string') {
      this.logger.error(`quote 响应缺少 data: ${JSON.stringify(response.body).slice(0, 300)}`);
      throw new EngineBudgetQuoteError(502, {
        error: { code: 'EXECUTION_BUDGET_QUOTE_INVALID', message: 'quote response missing data' },
      });
    }
    return this.signer.mint(quote, tenant.workspaceId);
  }
}

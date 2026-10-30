import { Inject, Injectable } from '@nestjs/common';
import { createPublicKey, randomUUID } from 'node:crypto';
import { SignJWT, exportJWK, importPKCS8 } from 'jose';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';

/**
 * 执行预算 Grant 签发(引擎 `execution-budget-grant/v1` 合同)。
 *
 * 与身份 token 完全分离:独立 RSA 钥、独立 kid、独立 issuer/audience。
 * Grant 一次性、请求绑定、≤5 分钟;claims 必须与引擎 quote 逐字段一致,
 * 否则引擎报 SCOPE_MISMATCH / GRANT_INVALID。
 */
export interface WorkspaceTechnicalQuote {
  schemaVersion: string;
  authorityKind: 'WORKSPACE_GRANT';
  operation: string;
  workspaceId: string;
  purpose: string;
  subjectType: string;
  subjectId: string;
  requestSha256: string;
  currency: 'USD';
  unit: 'microusd';
  requiredCapMicrousd: string;
  policyRevision: string;
  expiresAt: string;
}

export const EXECUTION_BUDGET_GRANT_AUDIENCE = 'global-backend:execution-budget';
export const EXECUTION_BUDGET_GRANT_TYPE = 'execution-budget-grant+jwt';

@Injectable()
export class EngineBudgetGrantSigner {
  private privateKey?: CryptoKey;
  private jwk?: JsonWebKey;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async init(): Promise<void> {
    this.privateKey = await importPKCS8(this.config.ENGINE_BUDGET_GRANT_PRIVATE_KEY, 'RS256', {
      extractable: false,
    });
    // 只发布公钥参数;引擎的 loadExecutionBudgetJwks 会拒绝带私钥字段的 JWKS。
    const publicKey = createPublicKey(this.config.ENGINE_BUDGET_GRANT_PRIVATE_KEY);
    const jwk = await exportJWK(publicKey);
    jwk.kid = this.config.ENGINE_BUDGET_GRANT_KEY_ID;
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    this.jwk = jwk;
  }

  /** `/.well-known/execution-budget-jwks.json` 的输出(只含公钥)。 */
  get publicJwks(): { keys: JsonWebKey[] } {
    if (!this.jwk) throw new Error('预算签名钥未初始化');
    return { keys: [this.jwk] };
  }

  /** 用引擎 quote 签发一次性 Grant;TTL 取 min(配置, quote.expiresAt)。 */
  async mint(quote: WorkspaceTechnicalQuote, workspaceId: string): Promise<string> {
    if (!this.privateKey) throw new Error('预算签名钥未初始化');
    if (quote.authorityKind !== 'WORKSPACE_GRANT') throw new Error('quote authority_kind 不是 WORKSPACE_GRANT');
    if (quote.workspaceId !== workspaceId) throw new Error('quote workspace 与当前租户不一致');
    if (quote.currency !== 'USD' || quote.unit !== 'microusd') throw new Error('quote 金额单位非法');
    if (!/^[1-9][0-9]*$/.test(quote.requiredCapMicrousd)) throw new Error('quote requiredCapMicrousd 非法');

    const now = Math.floor(Date.now() / 1000);
    const quoteExpiresAt = Math.floor(Date.parse(quote.expiresAt) / 1000);
    if (!Number.isSafeInteger(quoteExpiresAt)) throw new Error('quote expiresAt 非法');
    const expiresAt = Math.min(now + this.config.ENGINE_BUDGET_GRANT_TTL_SECONDS, quoteExpiresAt);
    if (expiresAt <= now) throw new Error('quote 已过期');

    return new SignJWT({
      schema_version: 'execution-budget-grant/v1',
      authority_kind: 'WORKSPACE_GRANT',
      purpose: quote.purpose,
      workspace_id: quote.workspaceId,
      subject_type: quote.subjectType,
      subject_id: quote.subjectId,
      request_sha256: quote.requestSha256,
      currency: 'USD',
      unit: 'microusd',
      cap_microusd: quote.requiredCapMicrousd,
    })
      .setProtectedHeader({
        alg: 'RS256',
        typ: EXECUTION_BUDGET_GRANT_TYPE,
        kid: this.config.ENGINE_BUDGET_GRANT_KEY_ID,
      })
      .setIssuer(this.config.ENGINE_BUDGET_GRANT_ISSUER)
      .setAudience(EXECUTION_BUDGET_GRANT_AUDIENCE)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(expiresAt)
      .sign(this.privateKey);
  }
}

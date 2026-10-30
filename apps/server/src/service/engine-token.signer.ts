/**
 * 引擎 JWT 铸造(PRD §2.3 / SD7):BFF 对引擎的每一次调用都现铸短 TTL token。
 *
 * claims:sub(用户 id)/ workspace(租户 UUID)/ roles(按 membership 角色)/ 标准 iss/aud/exp。
 * 角色名 saas-admin / saas-member / saas-event-consumer 的 scope 映射由引擎
 * AUTH_ROLE_SCOPE_MAP_JSON 配置(SD 表见 PRD §2.2)。
 */
import { Inject, Injectable } from '@nestjs/common';
import { createPublicKey } from 'node:crypto';
import { SignJWT, exportJWK, importPKCS8 } from 'jose';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';

export type SaasRole = 'saas-admin' | 'saas-member' | 'saas-event-consumer';

export interface MintInput {
  readonly subjectId: string;
  readonly workspaceId: string;
  readonly roles: readonly SaasRole[];
}

@Injectable()
export class EngineTokenSigner {
  private privateKey?: CryptoKey;
  private jwk?: JsonWebKey;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** 启动时导入 PEM;密钥形态非法即拒绝启动(配置校验之外的运行时校验)。 */
  async init(): Promise<void> {
    this.privateKey = await importPKCS8(this.config.ENGINE_JWT_PRIVATE_KEY, 'RS256', { extractable: false });
    // exportJWK(私钥) 会把 d/p/q/dp/dq/qi 一并导出——JWKS 只能发布公钥参数,故单独导出公钥。
    const publicKey = createPublicKey(this.config.ENGINE_JWT_PRIVATE_KEY);
    const jwk = await exportJWK(publicKey);
    jwk.kid = this.config.ENGINE_JWT_KEY_ID;
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    this.jwk = jwk;
  }

  /** JWKS 端点输出:只含公钥参数(kty/n/e/kid/alg/use)。 */
  async publicJwks(): Promise<{ keys: JsonWebKey[] }> {
    if (!this.jwk) throw new Error('签名钥未初始化');
    return { keys: [this.jwk] };
  }

  async mint(input: MintInput, ttlSeconds = 60): Promise<string> {
    if (!this.privateKey) throw new Error('签名钥未初始化');
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      workspace: input.workspaceId,
      roles: [...input.roles],
    })
      .setProtectedHeader({ alg: 'RS256', kid: this.config.ENGINE_JWT_KEY_ID })
      .setIssuer(this.config.ENGINE_JWT_ISSUER)
      .setAudience(this.config.ENGINE_JWT_AUDIENCE)
      .setSubject(input.subjectId)
      .setJti(crypto.randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSeconds)
      .sign(this.privateKey);
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { hkdfSync } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';

/**
 * ExecutionAuthorization 令牌签名（HS256，独立派生密钥）。
 * 密钥从 SESSION_SECRET 经 HKDF 派生（info=campaign-authz/v1），与会话/引擎 JWT 密钥
 * 分离，避免「同一密钥签名不同信任级令牌」的混淆面。引擎侧（M2.1 接入）持同一派生密钥，
 * 可对令牌做无状态预检；权威状态仍以 DB 行复核（verify 服务端逻辑）。
 */
export interface ExecutionAuthorizationClaims {
  authorizationId: string;
  workspaceId: string;
  campaignId: string;
  revisionId: string;
  planHash: string;
  scope: unknown;
}

const ISSUER = 'gain-saas';
const AUDIENCE = 'gain-saas-campaign-authz';

@Injectable()
export class CampaignTokenSigner {
  private readonly key: Uint8Array;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = new Uint8Array(
      hkdfSync(
        'sha256',
        Buffer.from(config.SESSION_SECRET, 'utf8'),
        Buffer.alloc(0),
        Buffer.from('campaign-authz/v1', 'utf8'),
        32,
      ),
    );
  }

  async sign(claims: ExecutionAuthorizationClaims, ttlSeconds: number): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      wsu: claims.workspaceId,
      camp: claims.campaignId,
      rev: claims.revisionId,
      ph: claims.planHash,
      scope: claims.scope as Record<string, unknown>,
    })
      .setProtectedHeader({ alg: 'HS256', kid: 'campaign-authz-v1' })
      .setSubject(claims.authorizationId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSeconds)
      .sign(this.key);
  }

  async verify(token: string): Promise<ExecutionAuthorizationClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER, audience: AUDIENCE });
      const { wsu, camp, rev, ph, scope } = payload as Record<string, unknown>;
      if (
        typeof payload.sub !== 'string' ||
        typeof wsu !== 'string' ||
        typeof camp !== 'string' ||
        typeof rev !== 'string' ||
        typeof ph !== 'string'
      ) {
        return null;
      }
      return {
        authorizationId: payload.sub,
        workspaceId: wsu,
        campaignId: camp,
        revisionId: rev,
        planHash: ph,
        scope,
      };
    } catch {
      return null;
    }
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { R4Keyring } from './r4-keyring.service.js';

/**
 * 机器 token 签发（P2）。
 *
 * 线格式逐字取自引擎的校验器 `apps/api/src/platform-authority/machine-token-verifier.ts`：
 *  - 外层信封恰好 8 个键，schemaVersion = platform-machine-token/v1
 *  - JWT header 恰好 alg/kid/typ；typ 按 profile 二选一
 *  - capability 的 aud 与 scope 都必须是 platform-automation-capability-read
 *  - temporal 侧 permissions 必须是固定的三条之一，且顺序一致
 *  - exp - iat 必须恰好 300 秒；jti 必须是 UUID
 * 任何一处偏离都会被引擎判 MachineTokenDeniedError，所以这里不做「宽松处理」。
 */

export const MACHINE_TOKEN_SCHEMA_VERSION = 'platform-machine-token/v1';
export const MACHINE_TOKEN_TTL_SECONDS = 300;

export type MachineTokenProfile =
  | 'capability-request'
  | 'temporal-platform-worker'
  | 'temporal-customer-worker'
  | 'temporal-customer-client'
  // 平台上的 schedule 只读身份（GrowthOS reader 同一 subject：growthos-temporal-reader）
  | 'temporal-reader';

const CAPABILITY_AUDIENCE = 'platform-automation-capability-read';

const TEMPORAL_PERMISSIONS: Record<string, readonly string[]> = {
  'temporal-platform-worker': ['platform-automation:worker'],
  'temporal-customer-worker': ['default:worker'],
  'temporal-customer-client': ['default:read', 'default:write'],
  'temporal-reader': ['platform-automation:read'],
};

export interface MachineTokenRequest {
  profile: MachineTokenProfile;
  nonce: string;
  subject: string;
  configurationRevision: string;
}

export interface MachineTokenEnvelope {
  schemaVersion: string;
  profile: MachineTokenProfile;
  nonce: string;
  subject: string;
  issuedAt: number;
  expiresAt: number;
  configurationRevision: string;
  token: string;
}

@Injectable()
export class MachineTokenService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly keyring: R4Keyring,
  ) {}

  async issue(request: MachineTokenRequest, now = Date.now()): Promise<MachineTokenEnvelope> {
    if (!/^[0-9a-f]{32}$/.test(request.nonce)) throw new Error('nonce 必须是 32 位小写 hex');
    if (!/^[0-9a-f]{64}$/.test(request.configurationRevision))
      throw new Error('configurationRevision 必须是 64 位小写 hex');
    if (request.profile !== 'capability-request' && !TEMPORAL_PERMISSIONS[request.profile])
      throw new Error(`未知 profile: ${request.profile}`);

    const iat = Math.floor(now / 1000);
    const exp = iat + MACHINE_TOKEN_TTL_SECONDS;
    const capability = request.profile === 'capability-request';
    // temporal 侧 token 必须由平台信任的 temporalRuntime 钥族签发：引擎的
    // TEMPORAL_MACHINE_JWKS_URI 与平台的 TEMPORAL_PLATFORM_JWKS_URI 都只抓
    // /.well-known/temporal-runtime-jwks.json。capability 侧由 machine 钥族签发，
    // 对应引擎 CAPABILITY_MACHINE_JWKS_URI = /.well-known/machine-jwks.json。
    const { key, kid } = this.keyring.signingKey(capability ? 'machine' : 'temporalRuntime');
    // 引擎逐字比对 iss：capability 用 CAPABILITY_MACHINE_ISSUER，temporal 用
    // TEMPORAL_MACHINE_ISSUER，两者是不同字符串。
    const issuer = capability
      ? this.config.R4_CAPABILITY_MACHINE_ISSUER
      : this.config.R4_MACHINE_TOKEN_ISSUER;
    const audience = capability
      ? CAPABILITY_AUDIENCE
      : this.config.R4_MACHINE_TOKEN_TEMPORAL_AUDIENCE;

    const claims: Record<string, unknown> = capability
      ? { scope: CAPABILITY_AUDIENCE }
      : {
          profile: request.profile,
          permissions: [...(TEMPORAL_PERMISSIONS[request.profile] ?? [])],
        };

    const token = await new SignJWT(claims)
      .setProtectedHeader({
        alg: 'RS256',
        kid,
        typ: capability ? 'platform-automation-capability-reader+jwt' : 'temporal-runtime+jwt',
      })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(request.subject)
      .setJti(randomUUID())
      .setIssuedAt(iat)
      .setNotBefore(iat)
      .setExpirationTime(exp)
      .sign(key);

    return {
      schemaVersion: MACHINE_TOKEN_SCHEMA_VERSION,
      profile: request.profile,
      nonce: request.nonce,
      subject: request.subject,
      issuedAt: iat,
      expiresAt: exp,
      configurationRevision: request.configurationRevision,
      token,
    };
  }
}

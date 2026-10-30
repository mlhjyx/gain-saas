import { Inject, Injectable } from '@nestjs/common';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { exportJWK, importPKCS8 } from 'jose';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';

/**
 * R4 平台权威的密钥族（P1）。
 *
 * 四个密钥族与身份钥、预算 Grant 钥完全分离：
 *  - machine          → `/.well-known/jwks.json` 之外的机器 token 钥族（见 R4_MACHINE_*）
 *  - capability       → `/.well-known/platform-capability-jwks.json`
 *  - temporalRuntime  → `/.well-known/temporal-runtime-jwks.json`
 *  - siteBuildBudget  → `/.well-known/site-build-budget-jwks.json`
 *
 * 只发布公钥参数。引擎侧的验签器会拒绝带私钥字段的 JWKS，所以这里逐字段挑选，
 * 不做「整份 JWK 去掉 d」这类容易漏字段的处理。
 */

export type R4KeyFamily = 'machine' | 'capability' | 'temporalRuntime' | 'siteBuildBudget';

/** 公钥 JWK：DOM 的 JsonWebKey 不含 kid/alg/use，这里显式声明。 */
export type R4PublicJwk = JsonWebKey & { kid: string; alg: 'RS256'; use: 'sig' };

export const R4_JWKS_PATHS: Record<R4KeyFamily, string> = {
  machine: '/.well-known/jwks.json',
  capability: '/.well-known/platform-capability-jwks.json',
  temporalRuntime: '/.well-known/temporal-runtime-jwks.json',
  siteBuildBudget: '/.well-known/site-build-budget-jwks.json',
};

type FamilyConfig = { privateKeyPem?: string; keyId?: string };

@Injectable()
export class R4Keyring {
  private readonly publicKeys = new Map<R4KeyFamily, R4PublicJwk>();
  private readonly privateKeys = new Map<R4KeyFamily, CryptoKey>();
  private readonly unavailable = new Set<R4KeyFamily>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async init(): Promise<void> {
    const families: Array<[R4KeyFamily, FamilyConfig]> = [
      ['machine', { privateKeyPem: this.config.R4_MACHINE_PRIVATE_KEY, keyId: this.config.R4_MACHINE_KEY_ID }],
      ['capability', { privateKeyPem: this.config.R4_CAPABILITY_PRIVATE_KEY, keyId: this.config.R4_CAPABILITY_KEY_ID }],
      ['temporalRuntime', { privateKeyPem: this.config.R4_TEMPORAL_RUNTIME_PRIVATE_KEY, keyId: this.config.R4_TEMPORAL_RUNTIME_KEY_ID }],
      ['siteBuildBudget', { privateKeyPem: this.config.R4_SITE_BUILD_BUDGET_PRIVATE_KEY, keyId: this.config.R4_SITE_BUILD_BUDGET_KEY_ID }],
    ];
    for (const [family, cfg] of families) {
      if (cfg.privateKeyPem) {
        await this.importFamily(family, cfg.privateKeyPem, cfg.keyId ?? `${family}-2026`);
        continue;
      }
      // 生产必须显式配置；开发/测试允许进程内临时密钥，重启即换。
      if (this.config.NODE_ENV === 'production') {
        this.unavailable.add(family);
        continue;
      }
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      await this.importFamily(family, pem, `${family}-ephemeral`);
    }
  }

  private async importFamily(family: R4KeyFamily, pem: string, kid: string): Promise<void> {
    const privateKey = await importPKCS8(pem, 'RS256', { extractable: false });
    const publicJwk = await exportJWK(createPublicKey(pem));
    // 只保留验签需要的字段，私钥参数一律不出。
    const jwk: R4PublicJwk = {
      kty: publicJwk.kty,
      n: publicJwk.n,
      e: publicJwk.e,
      kid,
      alg: 'RS256',
      use: 'sig',
    };
    this.privateKeys.set(family, privateKey);
    this.publicKeys.set(family, jwk);
  }

  isAvailable(family: R4KeyFamily): boolean {
    return this.publicKeys.has(family);
  }

  /** JWKS 输出：只含公钥；族不可用时抛错，由控制器转成 503。 */
  publicJwks(family: R4KeyFamily): { keys: R4PublicJwk[] } {
    const jwk = this.publicKeys.get(family);
    if (!jwk) throw new Error(`R4 密钥族不可用: ${family}`);
    return { keys: [jwk] };
  }

  privateKey(family: R4KeyFamily): CryptoKey {
    const key = this.privateKeys.get(family);
    if (!key) throw new Error(`R4 密钥族不可用: ${family}`);
    return key;
  }

  /** 供后续 P2/P3 签发使用（机器 token、capability）。 */
  signingKey(family: R4KeyFamily): { key: CryptoKey; kid: string } {
    const jwk = this.publicKeys.get(family);
    if (!jwk?.kid) throw new Error(`R4 密钥族不可用: ${family}`);
    return { key: this.privateKey(family), kid: jwk.kid };
  }
}

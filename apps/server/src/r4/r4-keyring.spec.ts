import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, createLocalJWKSet, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { R4Keyring, type R4KeyFamily } from './r4-keyring.service.js';

function pemPair(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return { NODE_ENV: 'development', ...overrides } as unknown as AppConfig;
}

const FAMILIES: R4KeyFamily[] = ['machine', 'capability', 'temporalRuntime', 'siteBuildBudget'];

describe('R4 密钥族', () => {
  it('开发环境未配置时生成临时密钥，四个族都可用', async () => {
    const keyring = new R4Keyring(config());
    await keyring.init();
    for (const family of FAMILIES) {
      expect(keyring.isAvailable(family)).toBe(true);
      expect(keyring.publicJwks(family).keys).toHaveLength(1);
    }
  });

  it('生产环境未配置时四个族都不可用（fail closed）', async () => {
    const keyring = new R4Keyring(config({ NODE_ENV: 'production' }));
    await keyring.init();
    for (const family of FAMILIES) {
      expect(keyring.isAvailable(family)).toBe(false);
      expect(() => keyring.publicJwks(family)).toThrow();
    }
  });

  it('只发布公钥参数，绝不带私钥字段', async () => {
    const keyring = new R4Keyring(config());
    await keyring.init();
    for (const family of FAMILIES) {
      const jwk = keyring.publicJwks(family).keys[0];
      expect(Object.keys(jwk).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
      for (const secret of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k']) {
        expect(jwk).not.toHaveProperty(secret);
      }
    }
  });

  it('生产环境显式配置后可用，且签出的 JWS 能被自家 JWKS 验证', async () => {
    const pem = pemPair();
    const keyring = new R4Keyring(
      config({
        NODE_ENV: 'production',
        R4_CAPABILITY_PRIVATE_KEY: pem,
        R4_CAPABILITY_KEY_ID: 'capability-test',
      }),
    );
    await keyring.init();
    expect(keyring.isAvailable('capability')).toBe(true);
    expect(keyring.isAvailable('machine')).toBe(false);

    const { key, kid } = keyring.signingKey('capability');
    const token = await new SignJWT({ hello: 'r4' })
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
      .setIssuer('https://127.0.0.1:18446/')
      .setAudience('global-backend')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);

    const jwks = createLocalJWKSet(keyring.publicJwks('capability'));
    const { payload } = await jwtVerify(token, jwks, {
      issuer: 'https://127.0.0.1:18446/',
      audience: 'global-backend',
    });
    expect(payload.hello).toBe('r4');
  });
});

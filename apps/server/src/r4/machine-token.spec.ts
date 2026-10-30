import { generateKeyPairSync } from 'node:crypto';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { MachineTokenService, MACHINE_TOKEN_TTL_SECONDS } from './machine-token.service.js';
import { R4Keyring } from './r4-keyring.service.js';

const ISSUER = 'https://127.0.0.1:18446/temporal-runtime';
const REVISION = 'a'.repeat(64);
const NONCE = 'b'.repeat(32);
const SUBJECT = 'global-backend-platform-worker';

async function service(): Promise<{ service: MachineTokenService; keyring: R4Keyring }> {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config = {
    NODE_ENV: 'development',
    R4_MACHINE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    R4_MACHINE_KEY_ID: 'machine-test',
    R4_MACHINE_TOKEN_ISSUER: ISSUER,
    R4_MACHINE_TOKEN_TEMPORAL_AUDIENCE: 'global-backend:platform-temporal',
  } as unknown as AppConfig;
  const keyring = new R4Keyring(config);
  await keyring.init();
  return { service: new MachineTokenService(config, keyring), keyring };
}

describe('机器 token 签发', () => {
  it('信封恰好 8 个键，且 issuedAt/expiresAt 相差 300 秒', async () => {
    const { service: s } = await service();
    const env = await s.issue({ profile: 'capability-request', nonce: NONCE, subject: SUBJECT, configurationRevision: REVISION });
    expect(Object.keys(env).sort()).toEqual([
      'configurationRevision', 'expiresAt', 'issuedAt', 'nonce', 'profile', 'schemaVersion', 'subject', 'token',
    ]);
    expect(env.schemaVersion).toBe('platform-machine-token/v1');
    expect(env.expiresAt - env.issuedAt).toBe(MACHINE_TOKEN_TTL_SECONDS);
  });

  it('capability profile：typ / aud / scope 与引擎校验一致', async () => {
    const { service: s, keyring } = await service();
    const env = await s.issue({ profile: 'capability-request', nonce: NONCE, subject: SUBJECT, configurationRevision: REVISION });
    const header = decodeProtectedHeader(env.token);
    expect(header).toEqual({ alg: 'RS256', kid: 'machine-test', typ: 'platform-automation-capability-reader+jwt' });
    const { payload } = await jwtVerify(env.token, createLocalJWKSet(keyring.publicJwks('machine')));
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'nbf', 'scope', 'sub']);
    expect(payload.aud).toBe('platform-automation-capability-read');
    expect(payload.scope).toBe('platform-automation-capability-read');
    expect(payload.exp! - payload.iat!).toBe(300);
    expect(String(payload.jti)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it.each([
    ['temporal-platform-worker', ['platform-automation:worker']],
    ['temporal-customer-worker', ['default:worker']],
    ['temporal-customer-client', ['default:read', 'default:write']],
  ] as const)('%s 的 permissions 与顺序固定', async (profile, permissions) => {
    const { service: s, keyring } = await service();
    const env = await s.issue({ profile, nonce: NONCE, subject: SUBJECT, configurationRevision: REVISION });
    expect(decodeProtectedHeader(env.token).typ).toBe('temporal-runtime+jwt');
    const { payload } = await jwtVerify(env.token, createLocalJWKSet(keyring.publicJwks('machine')));
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'nbf', 'permissions', 'profile', 'sub']);
    expect(payload.profile).toBe(profile);
    expect(payload.permissions).toEqual([...permissions]);
    expect(payload.aud).toBe('global-backend:platform-temporal');
  });

  it('拒绝非法 nonce / revision / profile', async () => {
    const { service: s } = await service();
    await expect(s.issue({ profile: 'capability-request', nonce: 'XYZ', subject: SUBJECT, configurationRevision: REVISION })).rejects.toThrow();
    await expect(s.issue({ profile: 'capability-request', nonce: NONCE, subject: SUBJECT, configurationRevision: 'zz' })).rejects.toThrow();
    await expect(
      s.issue({ profile: 'unknown-profile' as never, nonce: NONCE, subject: SUBJECT, configurationRevision: REVISION }),
    ).rejects.toThrow();
  });
});

import { generateKeyPairSync } from 'node:crypto';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { EngineTokenSigner } from './engine-token.signer.js';

const ISSUER = 'http://127.0.0.1:4020';
const AUDIENCE = 'global-backend';

function createSigner(): EngineTokenSigner {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return new EngineTokenSigner({
    ENGINE_JWT_PRIVATE_KEY: pem,
    ENGINE_JWT_KEY_ID: 'kid-test',
    ENGINE_JWT_ISSUER: ISSUER,
    ENGINE_JWT_AUDIENCE: AUDIENCE,
  } as unknown as AppConfig);
}

describe('EngineTokenSigner JWKS(SD7)', () => {
  it('JWKS 只发布公钥参数,不含 d/p/q/dp/dq/qi 等私钥成分', async () => {
    const signer = createSigner();
    await signer.init();
    const jwks = await signer.publicJwks();
    expect(jwks.keys).toHaveLength(1);
    expect(Object.keys(jwks.keys[0]).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
  });

  it('铸造的 token 能由公开 JWKS 验签,claims 与合同一致', async () => {
    const signer = createSigner();
    await signer.init();
    const workspaceId = '33fe8b32-e417-4355-af91-96fc042d59e0';
    const token = await signer.mint({ subjectId: 'user-1', workspaceId, roles: ['saas-admin'] });
    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(await signer.publicJwks()), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(protectedHeader.kid).toBe('kid-test');
    expect(payload.sub).toBe('user-1');
    expect((payload as { workspace?: string }).workspace).toBe(workspaceId);
    expect((payload as { roles?: string[] }).roles).toEqual(['saas-admin']);
  });
});

import { generateKeyPairSync } from 'node:crypto';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { EngineBudgetGrantSigner, type WorkspaceTechnicalQuote } from './engine-budget-grant.signer.js';

const ISSUER = 'https://127.0.0.1:18446/execution-budget';
const WORKSPACE = '982c2a12-e166-430e-973c-01eea42ae9ed';
const SHA = '39468bda56a1ab727bcad3f3cf48d2e7266a34a3552f00bd32c4fcdb9051541b';

function createSigner(): EngineBudgetGrantSigner {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return new EngineBudgetGrantSigner({
    ENGINE_BUDGET_GRANT_PRIVATE_KEY: pem,
    ENGINE_BUDGET_GRANT_KEY_ID: 'budget-kid-test',
    ENGINE_BUDGET_GRANT_ISSUER: ISSUER,
    ENGINE_BUDGET_GRANT_TTL_SECONDS: 240,
  } as unknown as AppConfig);
}

function quote(overrides: Partial<WorkspaceTechnicalQuote> = {}): WorkspaceTechnicalQuote {
  return {
    schemaVersion: 'execution-budget-technical-quote/v1',
    authorityKind: 'WORKSPACE_GRANT',
    operation: 'POST /companies',
    workspaceId: WORKSPACE,
    purpose: 'understanding.run',
    subjectType: 'company',
    subjectId: `request:${SHA}`,
    requestSha256: SHA,
    currency: 'USD',
    unit: 'microusd',
    requiredCapMicrousd: '5870000',
    policyRevision: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe('EngineBudgetGrantSigner(引擎 execution-budget-grant/v1)', () => {
  it('预算 JWKS 只发布公钥参数', async () => {
    const signer = createSigner();
    await signer.init();
    expect(Object.keys(signer.publicJwks.keys[0]).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
  });

  it('按 quote 签出可被公开 JWKS 验签的 Grant,claims 与引擎合同一致', async () => {
    const signer = createSigner();
    await signer.init();
    const grant = await signer.mint(quote(), WORKSPACE);

    const { payload, protectedHeader } = await jwtVerify(grant, createLocalJWKSet(signer.publicJwks), {
      issuer: ISSUER,
      audience: 'global-backend:execution-budget',
    });
    expect(protectedHeader.typ).toBe('execution-budget-grant+jwt');
    expect(protectedHeader.kid).toBe('budget-kid-test');
    expect(payload.schema_version).toBe('execution-budget-grant/v1');
    expect(payload.authority_kind).toBe('WORKSPACE_GRANT');
    expect(payload.purpose).toBe('understanding.run');
    expect(payload.workspace_id).toBe(WORKSPACE);
    expect(payload.subject_type).toBe('company');
    expect(payload.subject_id).toBe(`request:${SHA}`);
    expect(payload.request_sha256).toBe(SHA);
    expect(payload.currency).toBe('USD');
    expect(payload.unit).toBe('microusd');
    expect(payload.cap_microusd).toBe('5870000');
    expect(String(payload.jti)).toMatch(/^[0-9a-f-]{36}$/);
    const ttl = Number(payload.exp) - Number(payload.iat);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it('quote 的 workspace 与当前租户不一致时拒绝签发', async () => {
    const signer = createSigner();
    await signer.init();
    await expect(signer.mint(quote({ workspaceId: '00000000-0000-4000-8000-000000000001' }), WORKSPACE)).rejects.toThrow(
      /workspace/,
    );
  });

  it('quote 已过期时拒绝签发', async () => {
    const signer = createSigner();
    await signer.init();
    await expect(
      signer.mint(quote({ expiresAt: new Date(Date.now() - 1000).toISOString() }), WORKSPACE),
    ).rejects.toThrow(/过期/);
  });
});

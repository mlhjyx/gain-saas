import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import {
  FenceAckVerifier,
  FenceAckInvalid,
  FENCE_ACK_AUDIENCE,
  FENCE_ACK_TYPE,
} from './fence-ack-verifier.service.js';

const ISSUER = 'https://127.0.0.1:3443/';
const REVOCATION_JTI = '11111111-2222-4333-8444-555555555555';
const COMMAND = 'a.b.c';

async function backend(): Promise<{ sign: (claims: Record<string, unknown>) => Promise<string>; jwk: JsonWebKey }> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'fence-ack-test', alg: 'RS256', use: 'sig' } as JsonWebKey;
  return {
    jwk,
    sign: async (claims) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'fence-ack-test', typ: FENCE_ACK_TYPE })
        .setIssuer(ISSUER)
        .setAudience(FENCE_ACK_AUDIENCE)
        .sign(privateKey),
  };
}

function claims(overrides: Record<string, unknown> = {}, now = Math.floor(Date.now() / 1000)) {
  return {
    schema_version: 'PlatformExecutionBudgetFenceAcknowledged/v1',
    jti: randomUUID(),
    revocation_jti: REVOCATION_JTI,
    command_sha256: createHash('sha256').update(COMMAND, 'utf8').digest('hex'),
    schedule_id: 'acq-sweep',
    fence_sequence: '7',
    backend_generation: '3',
    committed_at: now - 1,
    in_flight_attempts: '0',
    iat: now,
    nbf: now,
    exp: now + 120,
    ...overrides,
  };
}

const expected = { revocationJti: REVOCATION_JTI, commandJws: COMMAND, scheduleId: 'acq-sweep', fenceSequence: '7' };

async function verifier(jwk: JsonWebKey | null): Promise<FenceAckVerifier> {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ keys: jwk ? [jwk] : [] }), { status: 200 }),
  ));
  return new FenceAckVerifier({
    R4_BACKEND_BASE_URL: 'http://127.0.0.1:3000',
    R4_FENCE_ACK_ISSUER: ISSUER,
  } as unknown as AppConfig);
}

describe('fence-ack 验证', () => {
  afterEach(() => vi.restoreAllMocks());

  it('接受绑定正确、窗口合规的 ACK', async () => {
    const { sign, jwk } = await backend();
    const v = await verifier(jwk);
    const ack = await sign(claims());
    const result = await v.verify(ack, expected);
    expect(result.schedule_id).toBe('acq-sweep');
  });

  it('拒绝 revocation_jti / command_sha256 / schedule / fence 不匹配', async () => {
    const { sign, jwk } = await backend();
    const v = await verifier(jwk);
    for (const bad of [
      claims({ revocation_jti: '99999999-8888-4777-8666-555555555555' }),
      claims({ command_sha256: 'f'.repeat(64) }),
      claims({ schedule_id: 'intent-sweep' }),
      claims({ fence_sequence: '8' }),
    ]) {
      await expect(v.verify(await sign(bad), expected)).rejects.toBeInstanceOf(FenceAckInvalid);
    }
  });

  it('拒绝窗口超 300 秒与 committed_at 晚于 iat', async () => {
    const { sign, jwk } = await backend();
    const v = await verifier(jwk);
    const now = Math.floor(Date.now() / 1000);
    await expect(v.verify(await sign(claims({ exp: now + 400 })), expected)).rejects.toThrow();
    await expect(v.verify(await sign(claims({ committed_at: now + 10 })), expected)).rejects.toThrow();
  });

  it('拒绝非 RS256/错误 typ 与空 JWKS', async () => {
    const { jwk } = await backend();
    const empty = await verifier(null);
    await expect(empty.verify('a.b.c', expected)).rejects.toBeInstanceOf(FenceAckInvalid);
    const v = await verifier(jwk);
    await expect(v.verify('not-a-jws', expected)).rejects.toBeInstanceOf(FenceAckInvalid);
  });
});

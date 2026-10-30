import { generateKeyPairSync } from 'node:crypto';
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { RevocationClient, RevocationDeliveryError } from './revocation-client.service.js';
import { RevocationIssuer, REVOCATION_TYPE } from './revocation-issuer.service.js';
import { R4Keyring } from './r4-keyring.service.js';

const ISSUER = 'https://127.0.0.1:18446/';
const COMMAND = {
  scheduleId: 'acq-sweep' as const,
  workflowRunId: '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607',
  fenceSequence: '7',
  reasonCode: 'OPERATOR_HOLD' as const,
  targetIssuer: ISSUER,
};

async function issuer(): Promise<{ issuer: RevocationIssuer; keyring: R4Keyring }> {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config = {
    NODE_ENV: 'development',
    R4_CAPABILITY_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    R4_CAPABILITY_KEY_ID: 'cap-test',
    R4_REVOCATION_TTL_SECONDS: 120,
  } as unknown as AppConfig;
  const keyring = new R4Keyring(config);
  await keyring.init();
  return { issuer: new RevocationIssuer(config, keyring), keyring };
}

describe('撤销签发', () => {
  it('header/payload 与后端契约一致', async () => {
    const { issuer: svc, keyring } = await issuer();
    const jws = await svc.issue(COMMAND);
    expect(decodeProtectedHeader(jws)).toEqual({ alg: 'RS256', kid: 'cap-test', typ: REVOCATION_TYPE });

    const payload = decodeJwt(jws);
    expect(Object.keys(payload).sort()).toEqual([
      'aud', 'exp', 'fence_sequence', 'iat', 'iss', 'nbf', 'reason_code',
      'revocation_jti', 'schedule_id', 'schema_version', 'target_issuer', 'target_jti', 'workflow_run_id',
    ]);
    expect(payload.schema_version).toBe('PlatformExecutionBudgetAuthorityRevoked/v1');
    expect(payload.aud).toBe('global-backend:execution-budget');
    expect(payload.iss).toBe(payload.target_issuer);
    expect(payload.schedule_id).toBe('acq-sweep');
    expect(payload.reason_code).toBe('OPERATOR_HOLD');
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(300);

    const { payload: verified } = await jwtVerify(jws, createLocalJWKSet(keyring.publicJwks('capability')));
    expect(verified.schema_version).toBe('PlatformExecutionBudgetAuthorityRevoked/v1');
  });

  it('拒绝未知 schedule / 非法 UUID / 非正 fence / 未知 reason', async () => {
    const { issuer: svc } = await issuer();
    await expect(svc.issue({ ...COMMAND, scheduleId: 'nope' as never })).rejects.toThrow(/schedule/);
    await expect(svc.issue({ ...COMMAND, workflowRunId: 'not-a-uuid' })).rejects.toThrow(/UUID/);
    await expect(svc.issue({ ...COMMAND, fenceSequence: '0' })).rejects.toThrow(/fenceSequence/);
    await expect(svc.issue({ ...COMMAND, reasonCode: 'WHATEVER' as never })).rejects.toThrow(/reason_code/);
    await expect(svc.issue({ ...COMMAND, targetIssuer: 'http://example.com/' })).rejects.toThrow(/https/);
  });
});

describe('撤销投递', () => {
  afterEach(() => vi.restoreAllMocks());

  it('按 application/jose 投递并返回 ACK', async () => {
    const fetchMock = vi.fn(async () => new Response('a.b.c', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new RevocationClient({ R4_BACKEND_BASE_URL: 'http://127.0.0.1:3000' } as unknown as AppConfig);
    const result = await client.deliver('x.y.z');
    expect(result.ack).toBe('a.b.c');
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://127.0.0.1:3000/api/v1/platform-authority/revocations');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/jose');
    expect(init.body).toBe('x.y.z');
  });

  it('后端错误码原样上抛', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 'PLATFORM_REVOCATION_SEQUENCE_CONFLICT' } }), { status: 409 }),
    ));
    const client = new RevocationClient({ R4_BACKEND_BASE_URL: 'http://127.0.0.1:3000' } as unknown as AppConfig);
    await expect(client.deliver('x.y.z')).rejects.toMatchObject({
      status: 409,
      code: 'PLATFORM_REVOCATION_SEQUENCE_CONFLICT',
    });
  });

  it('未配置后端基址时 503', async () => {
    const client = new RevocationClient({} as unknown as AppConfig);
    await expect(client.deliver('x.y.z')).rejects.toBeInstanceOf(RevocationDeliveryError);
  });
});

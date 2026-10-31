import { generateKeyPairSync } from 'node:crypto';
import { createLocalJWKSet, decodeProtectedHeader, decodeJwt, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { CapabilityIssuer, type CapabilityObservation } from './capability-issuer.service.js';
import { R4Keyring } from './r4-keyring.service.js';

const NOW = 1_700_000_000_000; // 整数毫秒
const REVISION = 'c'.repeat(40);

function fact(observedAt: number, validUntil: number) {
  return { status: 'ok' as const, observedAt, validUntil };
}

function observation(scheduleId: string, overrides: Partial<CapabilityObservation> = {}): CapabilityObservation {
  return {
    scheduleId,
    workflowType: 'acquisitionSweepWorkflow',
    taskQueue: 'understanding',
    mode: 'ENABLED',
    temporalPermission: fact(NOW - 100, NOW + 25_000),
    issuer: fact(NOW - 100, NOW + 25_000),
    revocationConsumer: fact(NOW - 100, NOW + 25_000),
    undeliveredCount: 0,
    oldestUndeliveredCreatedAt: null,
    ...overrides,
  };
}

async function issuer(): Promise<{ issuer: CapabilityIssuer; keyring: R4Keyring }> {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config = {
    NODE_ENV: 'development',
    R4_CAPABILITY_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    R4_CAPABILITY_KEY_ID: 'cap-test',
    R4_CAPABILITY_ISSUER: 'https://127.0.0.1:18446/',
    R4_CAPABILITY_AUDIENCE: 'global-backend:platform-temporal',
    R4_CAPABILITY_NAMESPACE: 'platform-automation',
    R4_CAPABILITY_TTL_SECONDS: 30,
  } as unknown as AppConfig;
  const keyring = new R4Keyring(config);
  await keyring.init();
  return { issuer: new CapabilityIssuer(config, keyring), keyring };
}

const contexts = {
  nonce: 'd'.repeat(32),
  backendSha: REVISION,
  growthosSha: 'e'.repeat(40),
  policyDigest: `sha256:${'f'.repeat(64)}`,
};

describe('capability 签发', () => {
  it('payload 恰好 10 个键，header 恰好 alg/kid/typ', async () => {
    const { issuer: svc, keyring } = await issuer();
    const token = await svc.issue(
      ['acq-sweep', 'intent-sweep', 'sanctions-refresh', 'patents-cache-refresh'].map((s) => observation(s)),
      contexts,
      NOW,
    );
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'RS256', kid: 'cap-test', typ: 'platform-capability+jwt' });
    expect(Object.keys(decodeJwt(token)).sort()).toEqual([
      'aud', 'backendSha', 'exp', 'growthosSha', 'iat', 'iss', 'namespace', 'nonce', 'policyDigest', 'rows',
    ]);
    const { payload } = await jwtVerify(token, createLocalJWKSet(keyring.publicJwks('capability')), {
      currentDate: new Date(NOW),
    });
    expect(payload.iat! - 1_700_000_000).toBe(0);
    expect(payload.exp! - payload.iat!).toBe(30);
  });

  it('每条 row 恰好 9 个键，三种事实恰好 3 个键且 status=ok', async () => {
    const { issuer: svc } = await issuer();
    const token = await svc.issue([observation('acq-sweep')], contexts, NOW);
    const payload = decodeJwt(token) as { rows: Array<Record<string, unknown>> };
    const row = payload.rows[0]!;
    expect(Object.keys(row).sort()).toEqual([
      'issuer', 'mode', 'oldestUndeliveredCreatedAt', 'revocationConsumer',
      'scheduleId', 'taskQueue', 'temporalPermission', 'undeliveredCount', 'workflowType',
    ]);
    for (const key of ['temporalPermission', 'issuer', 'revocationConsumer']) {
      const f = row[key] as Record<string, unknown>;
      expect(Object.keys(f).sort()).toEqual(['observedAt', 'status', 'validUntil']);
      expect(f.status).toBe('ok');
    }
  });

  it('允许签发前采集的事实（引擎只限制观测晚于签发 1 秒以上）', async () => {
    const { issuer: svc } = await issuer();
    await expect(
      svc.issue([observation('acq-sweep', { temporalPermission: fact(NOW - 5_000, NOW + 20_000) })], contexts, NOW),
    ).resolves.toBeTypeOf('string');
  });

  it('拒绝观测晚于签发 1 秒以上的事实（时钟漂移防护）', async () => {
    const { issuer: svc } = await issuer();
    await expect(
      svc.issue([observation('acq-sweep', { temporalPermission: fact(NOW + 5_000, NOW + 20_000) })], contexts, NOW),
    ).rejects.toThrow(/1 秒/);
  });

  it('拒绝 revocationConsumer 窗口超过 30 秒', async () => {
    const { issuer: svc } = await issuer();
    await expect(
      svc.issue([observation('acq-sweep', { revocationConsumer: fact(NOW - 100, NOW + 60_000) })], contexts, NOW),
    ).rejects.toThrow(/30 秒/);
  });

  it('拒绝无积压却给出 oldest，以及积压超过 30 秒', async () => {
    const { issuer: svc } = await issuer();
    await expect(
      svc.issue([observation('acq-sweep', { undeliveredCount: 0, oldestUndeliveredCreatedAt: NOW - 1000 })], contexts, NOW),
    ).rejects.toThrow(/null/);
    await expect(
      svc.issue([observation('acq-sweep', { undeliveredCount: 3, oldestUndeliveredCreatedAt: NOW - 40_000 })], contexts, NOW),
    ).rejects.toThrow(/积压/);
  });

  it('拒绝重复 scheduleId 与非法 mode', async () => {
    const { issuer: svc } = await issuer();
    await expect(svc.issue([observation('acq-sweep'), observation('acq-sweep')], contexts, NOW)).rejects.toThrow(/重复/);
    await expect(
      svc.issue([observation('acq-sweep', { mode: 'PAUSED' as never })], contexts, NOW),
    ).rejects.toThrow(/mode/);
  });
});

import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_FACT_KEYS,
  CAPABILITY_JWS_HEADER_KEYS,
  CAPABILITY_JWS_PAYLOAD_KEYS,
  CAPABILITY_MODES,
  CAPABILITY_ROW_KEYS,
  MACHINE_TOKEN_BASE_CLAIMS,
  MACHINE_TOKEN_PROFILE_VARIANT_CLAIMS,
  MACHINE_TOKEN_SCOPE_VARIANT_CLAIMS,
  PLATFORM_SCHEDULES,
  REQUIRED_JWKS_PATHS,
  hasExactKeys,
  isCompactJson,
} from './r4-wire-contracts';

/**
 * P0 契约夹具：这些断言在 gain-saas 尚未实现 R4 之前就应通过。
 * 它们把 backend 的线格式冻结下来——将来实现偏离契约时，这里先红。
 */

const sampleFact = (observedAt: number, validUntil: number) => ({
  status: 'ok' as const,
  observedAt,
  validUntil,
});

const sampleRow = (scheduleId: string) => ({
  scheduleId,
  workflowType: 'acquisitionSweepWorkflow',
  taskQueue: 'understanding',
  mode: 'ENABLED',
  temporalPermission: sampleFact(1_700_000_000_000, 1_700_000_060_000),
  issuer: sampleFact(1_700_000_000_000, 1_700_000_060_000),
  revocationConsumer: sampleFact(1_700_000_000_000, 1_700_000_060_000),
  undeliveredCount: 0,
  oldestUndeliveredCreatedAt: null,
});

const samplePayload = () => ({
  iss: 'https://127.0.0.1:18446/',
  aud: 'global-backend',
  iat: 1_700_000_000,
  exp: 1_700_000_060,
  nonce: 'a'.repeat(32),
  backendSha: 'b'.repeat(40),
  growthosSha: 'c'.repeat(40),
  policyDigest: `sha256:${'d'.repeat(64)}`,
  namespace: 'platform-automation',
  rows: PLATFORM_SCHEDULES.map(sampleRow),
});

describe('R4 线格式契约', () => {
  it('capability payload 的键集与 backend 校验器完全一致', () => {
    expect(hasExactKeys(samplePayload(), CAPABILITY_JWS_PAYLOAD_KEYS)).toBe(true);
    const extra = { ...samplePayload(), unexpected: 1 };
    expect(hasExactKeys(extra, CAPABILITY_JWS_PAYLOAD_KEYS)).toBe(false);
    const { nonce: _drop, ...missing } = samplePayload();
    expect(hasExactKeys(missing, CAPABILITY_JWS_PAYLOAD_KEYS)).toBe(false);
  });

  it('capability row 的 9 个键一个不多一个不少', () => {
    for (const scheduleId of PLATFORM_SCHEDULES) {
      expect(hasExactKeys(sampleRow(scheduleId), CAPABILITY_ROW_KEYS)).toBe(true);
    }
    expect(hasExactKeys({ ...sampleRow('acq-sweep'), extra: true }, CAPABILITY_ROW_KEYS)).toBe(false);
  });

  it('每个事实对象是 {status, observedAt, validUntil}', () => {
    const row = sampleRow('acq-sweep');
    for (const fact of [row.temporalPermission, row.issuer, row.revocationConsumer]) {
      expect(hasExactKeys(fact, CAPABILITY_FACT_KEYS)).toBe(true);
      expect(fact.status).toBe('ok');
    }
  });

  it('capability header 只允许 alg/kid/typ', () => {
    expect(hasExactKeys({ alg: 'RS256', kid: 'cap-2026', typ: 'JWT' }, CAPABILITY_JWS_HEADER_KEYS)).toBe(true);
    expect(hasExactKeys({ alg: 'RS256', kid: 'cap-2026', typ: 'JWT', extra: 1 }, CAPABILITY_JWS_HEADER_KEYS)).toBe(false);
  });

  it('机器 token 的声明集：base 加各自变体', () => {
    const base = { iss: 'i', aud: 'a', sub: 's', jti: 'j', iat: 1, nbf: 1, exp: 2 };
    expect(hasExactKeys(base, MACHINE_TOKEN_BASE_CLAIMS)).toBe(true);
    const scopeVariant = { ...base, scope: 'platform.automation' };
    expect(
      hasExactKeys(scopeVariant, [...MACHINE_TOKEN_BASE_CLAIMS, ...MACHINE_TOKEN_SCOPE_VARIANT_CLAIMS]),
    ).toBe(true);
    const profileVariant = { ...base, profile: 'p', permissions: ['x'] };
    expect(
      hasExactKeys(profileVariant, [...MACHINE_TOKEN_BASE_CLAIMS, ...MACHINE_TOKEN_PROFILE_VARIANT_CLAIMS]),
    ).toBe(true);
    expect(hasExactKeys({ ...base, scope: 'x', profile: 'p' }, MACHINE_TOKEN_BASE_CLAIMS)).toBe(false);
  });

  it('rows 必须覆盖四个 platform schedule，且模式受限于两种取值', () => {
    expect(PLATFORM_SCHEDULES).toHaveLength(4);
    expect(new Set(PLATFORM_SCHEDULES).size).toBe(4);
    expect(new Set(CAPABILITY_MODES)).toEqual(
      new Set(['ENABLED', 'INTENTIONALLY_DISABLED_NO_EGRESS']),
    );
  });

  it('迁移后要由 gain-saas 提供的 JWKS 是四份（不含已在 18446 的 execution-budget）', () => {
    expect(REQUIRED_JWKS_PATHS).toHaveLength(4);
    expect(REQUIRED_JWKS_PATHS).not.toContain('/.well-known/execution-budget-jwks.json');
  });

  it('capability JOSE 段必须是紧凑 JSON', () => {
    expect(isCompactJson(JSON.stringify(samplePayload()))).toBe(true);
    expect(isCompactJson(JSON.stringify(samplePayload(), null, 2))).toBe(false);
  });
});

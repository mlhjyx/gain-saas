/**
 * R4 平台权威的线格式契约（P0：先冻结契约，再实现）。
 *
 * 这里的每个键集都是逐字抄自 backend 的校验器，不是我们自己设计的：
 *  - capability JWS header / payload：apps/api/src/platform-authority/platform-capability-signature.ts
 *  - capability row：apps/api/src/platform-authority/platform-capability-rows.ts
 *  - 机器 token 声明：apps/api/src/platform-authority/machine-token-verifier.ts
 *  - JWKS 端点：backend 运行时 env 里 *_JWKS_URI 指向 GrowthOS(18444/18081) 的那几份
 *
 * backend 用「键集完全相等」判定（多一个键、少一个键都算契约破坏），
 * 所以本文件也按精确相等来写测试。
 */

export const CAPABILITY_JWS_HEADER_KEYS = ['alg', 'kid', 'typ'] as const;

export const CAPABILITY_JWS_PAYLOAD_KEYS = [
  'iss',
  'aud',
  'iat',
  'exp',
  'nonce',
  'backendSha',
  'growthosSha',
  'policyDigest',
  'namespace',
  'rows',
] as const;

export const CAPABILITY_ROW_KEYS = [
  'scheduleId',
  'workflowType',
  'taskQueue',
  'mode',
  'temporalPermission',
  'issuer',
  'revocationConsumer',
  'undeliveredCount',
  'oldestUndeliveredCreatedAt',
] as const;

export const CAPABILITY_FACT_KEYS = ['status', 'observedAt', 'validUntil'] as const;

/** 机器 token：base 声明集；两种变体各自再加自己的键。 */
export const MACHINE_TOKEN_BASE_CLAIMS = [
  'iss',
  'aud',
  'sub',
  'jti',
  'iat',
  'nbf',
  'exp',
] as const;
export const MACHINE_TOKEN_SCOPE_VARIANT_CLAIMS = ['scope'] as const;
export const MACHINE_TOKEN_PROFILE_VARIANT_CLAIMS = ['profile', 'permissions'] as const;

export type PlatformScheduleId =
  | 'acq-sweep'
  | 'intent-sweep'
  | 'sanctions-refresh'
  | 'patents-cache-refresh';

export const PLATFORM_SCHEDULES: readonly PlatformScheduleId[] = [
  'acq-sweep',
  'intent-sweep',
  'sanctions-refresh',
  'patents-cache-refresh',
];

/**
 * 后端要验、当前由 GrowthOS 提供的 JWKS（迁移后由 gain-saas 提供）。
 * execution-budget-jwks.json 已在 gain-saas(18446) 上，不在本迁移范围。
 */
export const REQUIRED_JWKS_PATHS = [
  '/.well-known/jwks.json', // 机器 token + target reader
  '/.well-known/platform-capability-jwks.json',
  '/.well-known/temporal-runtime-jwks.json',
  '/.well-known/site-build-budget-jwks.json',
] as const;

/** capability 的 rows 只接受这两种模式。 */
export const CAPABILITY_MODES = ['ENABLED', 'INTENTIONALLY_DISABLED_NO_EGRESS'] as const;

export function hasExactKeys(value: unknown, keys: readonly string[]): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Object.keys(value as Record<string, unknown>);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * backend 要求 capability 的 JOSE 段是「紧凑 JSON」：
 * 不允许重复成员，且 JSON.stringify(parsed) 必须与原文逐字节一致。
 */
export function isCompactJson(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return JSON.stringify(parsed) === text;
  } catch {
    return false;
  }
}

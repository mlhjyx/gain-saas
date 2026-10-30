import { Inject, Injectable } from '@nestjs/common';
import { SignJWT } from 'jose';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { R4Keyring } from './r4-keyring.service.js';

/**
 * Capability 签发（P3）。
 *
 * 约束逐字取自引擎：
 *  - payload 键恰好 10 个（platform-capability-signature.ts 的 PAYLOAD_KEYS）
 *  - row 键恰好 9 个、三种事实键恰好 3 个且 status 必须为 ok
 *    （platform-capability-rows.ts）
 *  - 新鲜度（platform-capability-freshness.ts）：capability 的 iat/exp 相差
 *    ≤ 30 秒；每个事实的 observedAt 不得晚于签发、且与签发相差 < 1 秒；
 *    revocationConsumer 还要求 (now - observedAt) < 30 秒
 *
 * 因此本服务**不缓存**：每次请求都用调用方传入的即时观测值签发。
 */

export type CapabilityMode = 'ENABLED' | 'INTENTIONALLY_DISABLED_NO_EGRESS';

export interface CapabilityFact {
  status: 'ok';
  observedAt: number;
  validUntil: number;
}

export interface CapabilityObservation {
  scheduleId: string;
  workflowType: string;
  taskQueue: string;
  mode: CapabilityMode;
  temporalPermission: CapabilityFact;
  issuer: CapabilityFact;
  revocationConsumer: CapabilityFact;
  undeliveredCount: number;
  oldestUndeliveredCreatedAt: number | null;
}

export interface CapabilityContext {
  nonce: string;
  backendSha: string;
  growthosSha: string;
  policyDigest: string;
}

export const CAPABILITY_MAX_TTL_SECONDS = 30;
const FACT_OBSERVATION_SKEW_MS = 1000;

@Injectable()
export class CapabilityIssuer {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly keyring: R4Keyring,
  ) {}

  async issue(observations: readonly CapabilityObservation[], context: CapabilityContext, now = Date.now()): Promise<string> {
    if (!/^[0-9a-f]{32}$/.test(context.nonce)) throw new Error('nonce 必须是 32 位小写 hex');
    if (observations.length === 0 || observations.length > 4) throw new Error('rows 必须是 1–4 条');
    const issuedAtMs = Math.floor(now);
    const iat = Math.floor(issuedAtMs / 1000);
    const ttl = Math.min(this.config.R4_CAPABILITY_TTL_SECONDS, CAPABILITY_MAX_TTL_SECONDS);
    const exp = iat + ttl;

    const rows = observations.map((row) => this.row(row, issuedAtMs));
    if (new Set(rows.map((r) => r.scheduleId)).size !== rows.length)
      throw new Error('scheduleId 重复');

    const { key, kid } = this.keyring.signingKey('capability');
    return new SignJWT({
      nonce: context.nonce,
      backendSha: context.backendSha,
      growthosSha: context.growthosSha,
      policyDigest: context.policyDigest,
      namespace: this.config.R4_CAPABILITY_NAMESPACE,
      rows,
    })
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
      .setIssuer(this.config.R4_CAPABILITY_ISSUER)
      .setAudience(this.config.R4_CAPABILITY_AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(key);
  }

  private row(row: CapabilityObservation, issuedAtMs: number) {
    const fact = (value: CapabilityFact, consumer: boolean): CapabilityFact => {
      if (value.status !== 'ok') throw new Error(`事实状态不是 ok: ${row.scheduleId}`);
      for (const [name, instant] of [
        ['observedAt', value.observedAt],
        ['validUntil', value.validUntil],
      ] as const) {
        if (!Number.isSafeInteger(instant) || instant < 0)
          throw new Error(`${name} 必须是整数毫秒`);
      }
      if (value.observedAt > issuedAtMs) throw new Error('事实观测晚于签发');
      if (issuedAtMs - value.observedAt >= FACT_OBSERVATION_SKEW_MS)
        throw new Error('事实必须在签发前 1 秒内观测');
      if (value.validUntil <= value.observedAt) throw new Error('validUntil 必须晚于 observedAt');
      if (consumer && value.validUntil - value.observedAt > 30_000)
        throw new Error('revocationConsumer 的有效窗口不得超过 30 秒');
      return { status: 'ok', observedAt: value.observedAt, validUntil: value.validUntil };
    };
    if (row.mode !== 'ENABLED' && row.mode !== 'INTENTIONALLY_DISABLED_NO_EGRESS')
      throw new Error(`非法 mode: ${row.mode}`);
    if (!Number.isSafeInteger(row.undeliveredCount) || row.undeliveredCount < 0)
      throw new Error('undeliveredCount 必须是非负整数');
    if (row.undeliveredCount === 0 && row.oldestUndeliveredCreatedAt !== null)
      throw new Error('无积压时 oldestUndeliveredCreatedAt 必须为 null');
    if (row.undeliveredCount > 0) {
      if (!Number.isSafeInteger(row.oldestUndeliveredCreatedAt))
        throw new Error('有积压时必须给出 oldestUndeliveredCreatedAt');
      if ((row.oldestUndeliveredCreatedAt as number) > issuedAtMs)
        throw new Error('oldestUndeliveredCreatedAt 不能晚于签发');
      if (issuedAtMs - (row.oldestUndeliveredCreatedAt as number) >= 30_000)
        throw new Error('积压已超过 30 秒，不能签发');
    }
    return {
      scheduleId: row.scheduleId,
      workflowType: row.workflowType,
      taskQueue: row.taskQueue,
      mode: row.mode,
      temporalPermission: fact(row.temporalPermission, false),
      issuer: fact(row.issuer, false),
      revocationConsumer: fact(row.revocationConsumer, true),
      undeliveredCount: row.undeliveredCount,
      oldestUndeliveredCreatedAt: row.oldestUndeliveredCreatedAt,
    };
  }
}

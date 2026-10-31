import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SignJWT, importPKCS8 } from 'jose';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import { PLATFORM_SCHEDULES, type PlatformScheduleId } from './contracts/r4-wire-contracts.js';
import { bindingInstant } from './platform-facts.service.js';
import {
  PlatformPolicyDenied,
  PLATFORM_POLICY_GUARD,
  type PlatformGrantPolicyGuard,
} from './platform-policy-state.service.js';

/**
 * 平台运行 Grant 的持久签发（P7 后的准入 v2）。
 *
 * 引擎的 `ingest_and_admit_platform_execution_budget_run_v2` 要求每个平台运行
 * 带一张权威签发的 Grant，绑定 schedule / workflow / run / 技术策略，max_runs=1。
 * 契约逐字取自引擎校验器（execution-budget-grant.verifier.ts 的
 * PLATFORM_COMMAND_CLAIMS，恰好 21 个键）：
 *  - header 恰好 alg/kid/typ，typ = execution-budget-grant+jwt，用执行预算钥族签发
 *  - claims：schema_version / iss / aud / jti / iat / nbf / exp / authority_kind /
 *    purpose / subject_type / subject_id / schedule_id / schedule_request_sha256 /
 *    workflow_id / workflow_run_id / technical_policy_revision / currency / unit /
 *    cap_per_run_microusd / campaign_cap_microusd / max_runs
 *  - exp - iat ≤ 300 秒；campaign 上限必须等于每次运行上限（v2 的 CHECK 要求）
 *
 * 权威职责（不重复引擎的策略引擎）：schedule 必须是已知的四个之一、purpose 与
 * schedule 匹配、schedule_request_sha256 与 technical_policy_revision 必须等于
 * 权威自己持有的策略副本（`R4_PLATFORM_GRANT_EXPECTED`；注意部署绑定里的
 * `scheduleActions[].actionSha256` 是 Temporal schedule action 的摘要，**不是**
 * policy 行的 schedule_request_sha256，两者不能互相替代）、每次运行金额不得超过
 * 逐 schedule 配置上限、部署绑定未过期。
 * 先落库再返回字节：同一 workflow_run_id 重试拿回同一张 JWS。
 */

export const PLATFORM_GRANT_TYPE = 'execution-budget-grant+jwt';
export const PLATFORM_GRANT_SCHEMA = 'execution-budget-grant/v1';
export const PLATFORM_GRANT_AUDIENCE = 'global-backend:execution-budget';

const PURPOSE_BY_SCHEDULE: Record<PlatformScheduleId, string> = {
  'acq-sweep': 'platform.acquisition',
  'patents-cache-refresh': 'platform.acquisition',
  'intent-sweep': 'platform.intent_watch',
  'sanctions-refresh': 'platform.sanctions',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const DECIMAL = /^[1-9][0-9]*$/;

export class PlatformGrantRejected extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface PlatformGrantRequest {
  scheduleId: string;
  purpose: string;
  workflowId: string;
  workflowRunId: string;
  scheduleRequestSha256: string;
  technicalPolicyRevision: string;
  capPerRunMicrousd: string;
  campaignCapMicrousd: string;
}

export interface IssuedPlatformGrant {
  token: string;
  expiresAt: number;
}

interface BindingAction {
  scheduleId?: unknown;
  actionSha256?: unknown;
}

@Injectable()
export class PlatformGrantIssuer {
  private privateKey?: CryptoKey;
  private ceilings?: Map<string, bigint>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    // 策略门可选：单测直接构造时不注入；Nest 下由 R4Module 提供。
    @Optional() @Inject(PLATFORM_POLICY_GUARD) private readonly policy?: PlatformGrantPolicyGuard | null,
  ) {}

  private async key(): Promise<CryptoKey> {
    this.privateKey ??= await importPKCS8(this.config.ENGINE_BUDGET_GRANT_PRIVATE_KEY, 'RS256');
    return this.privateKey;
  }

  private capCeilings(): Map<string, bigint> {
    if (this.ceilings) return this.ceilings;
    let raw: unknown;
    try {
      raw = JSON.parse(this.config.R4_PLATFORM_GRANT_MAX_CAP_MICROUSD);
    } catch {
      throw new PlatformGrantRejected('PLATFORM_GRANT_CONFIGURATION_INVALID', '上限配置不是合法 JSON');
    }
    const map = new Map<string, bigint>();
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [schedule, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value !== 'string' || !DECIMAL.test(value))
          throw new PlatformGrantRejected('PLATFORM_GRANT_CONFIGURATION_INVALID', `上限配置非法: ${schedule}`);
        map.set(schedule, BigInt(value));
      }
    }
    for (const schedule of PLATFORM_SCHEDULES) {
      if (!map.has(schedule))
        throw new PlatformGrantRejected('PLATFORM_GRANT_CONFIGURATION_INVALID', `缺少上限配置: ${schedule}`);
    }
    this.ceilings = map;
    return map;
  }

  /** 权威持有的策略副本：逐 schedule 的 request/envelope 摘要。 */
  private expectedPolicy(scheduleId: PlatformScheduleId): { requestSha256: string; envelopeSha256: string } {
    let raw: unknown;
    try {
      raw = JSON.parse(this.config.R4_PLATFORM_GRANT_EXPECTED);
    } catch {
      throw new PlatformGrantRejected('PLATFORM_GRANT_CONFIGURATION_INVALID', '策略副本不是合法 JSON');
    }
    const entry = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[scheduleId] : undefined;
    const requestSha256 = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).requestSha256 : undefined;
    const envelopeSha256 = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).envelopeSha256 : undefined;
    if (typeof requestSha256 !== 'string' || !SHA256.test(requestSha256) || typeof envelopeSha256 !== 'string' || !SHA256.test(envelopeSha256))
      throw new PlatformGrantRejected('PLATFORM_GRANT_CONFIGURATION_INVALID', `策略副本缺少 schedule: ${scheduleId}`);
    return { requestSha256, envelopeSha256 };
  }

  /** 部署绑定只证明部署身份与有效期；schedule 必须出现在绑定的 scheduleActions 里。 */
  private assertBindingValid(scheduleId: PlatformScheduleId, now: number): void {
    const file = this.config.R4_DEPLOYMENT_BINDING_FILE;
    if (!file) throw new PlatformGrantRejected('PLATFORM_GRANT_BINDING_UNAVAILABLE', '未配置部署绑定文件');
    let binding: { validUntil?: unknown; scheduleActions?: unknown; revokedAt?: unknown };
    try {
      binding = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new PlatformGrantRejected('PLATFORM_GRANT_BINDING_UNAVAILABLE', '部署绑定不可读');
    }
    // 显式撤销与自然过期语义不同：撤销一出现就停发新 Grant（撤销请求由监视器另行发起）。
    const revokedAt = bindingInstant(binding.revokedAt);
    if (Number.isFinite(revokedAt))
      throw new PlatformGrantRejected('PLATFORM_GRANT_BINDING_REVOKED', '部署绑定已被显式撤销');
    const validUntil =
      typeof binding.validUntil === 'number'
        ? binding.validUntil
        : typeof binding.validUntil === 'string'
          ? Date.parse(binding.validUntil)
          : Number.NaN;
    if (Number.isNaN(validUntil) || validUntil <= now)
      throw new PlatformGrantRejected('PLATFORM_GRANT_BINDING_UNAVAILABLE', '部署绑定已过期');
    const actions = Array.isArray(binding.scheduleActions) ? (binding.scheduleActions as BindingAction[]) : [];
    const action = actions.find((candidate) => candidate?.scheduleId === scheduleId);
    if (!action || typeof action.actionSha256 !== 'string' || !SHA256.test(action.actionSha256))
      throw new PlatformGrantRejected('PLATFORM_GRANT_BINDING_UNAVAILABLE', `部署绑定缺少 schedule: ${scheduleId}`);
  }

  private validate(request: PlatformGrantRequest, now: number): void {
    if (!PLATFORM_SCHEDULES.includes(request.scheduleId as PlatformScheduleId))
      throw new PlatformGrantRejected('PLATFORM_GRANT_SCHEDULE_UNKNOWN', `未知 schedule: ${request.scheduleId}`);
    const scheduleId = request.scheduleId as PlatformScheduleId;
    if (request.purpose !== PURPOSE_BY_SCHEDULE[scheduleId])
      throw new PlatformGrantRejected('PLATFORM_GRANT_PURPOSE_MISMATCH', 'purpose 与 schedule 不匹配');
    if (!WORKFLOW_ID.test(request.workflowId))
      throw new PlatformGrantRejected('PLATFORM_GRANT_REQUEST_INVALID', 'workflowId 非法');
    if (!UUID.test(request.workflowRunId))
      throw new PlatformGrantRejected('PLATFORM_GRANT_REQUEST_INVALID', 'workflowRunId 非法');
    this.assertBindingValid(scheduleId, now);
    const expected = this.expectedPolicy(scheduleId);
    if (request.scheduleRequestSha256 !== expected.requestSha256)
      throw new PlatformGrantRejected('PLATFORM_GRANT_REQUEST_MISMATCH', 'scheduleRequestSha256 与权威策略副本不一致');
    if (request.technicalPolicyRevision !== expected.envelopeSha256)
      throw new PlatformGrantRejected('PLATFORM_GRANT_REQUEST_MISMATCH', 'technicalPolicyRevision 与权威策略副本不一致');
    if (!DECIMAL.test(request.capPerRunMicrousd) || !DECIMAL.test(request.campaignCapMicrousd))
      throw new PlatformGrantRejected('PLATFORM_GRANT_REQUEST_INVALID', '金额必须是正十进制字符串');
    if (request.campaignCapMicrousd !== request.capPerRunMicrousd)
      throw new PlatformGrantRejected('PLATFORM_GRANT_REQUEST_INVALID', 'campaign 上限必须等于每次运行上限');
    const ceiling = this.capCeilings().get(scheduleId)!;
    if (BigInt(request.capPerRunMicrousd) > ceiling)
      throw new PlatformGrantRejected('PLATFORM_GRANT_CAP_EXCEEDED', `超过该 schedule 的金额上限: ${ceiling}`);
  }

  /** 纵深防御：策略停用或有未结撤销请求时拒绝新 Grant（引擎 readiness 也会挡住）。 */
  private async assertPolicy(scheduleId: string): Promise<void> {
    if (!this.policy) return;
    try {
      await this.policy.assertIssuable(scheduleId);
    } catch (error) {
      if (error instanceof PlatformPolicyDenied)
        throw new PlatformGrantRejected(error.code, error.message);
      throw error;
    }
  }

  async issue(request: PlatformGrantRequest, now = Date.now()): Promise<IssuedPlatformGrant> {
    this.validate(request, now);
    await this.assertPolicy(request.scheduleId);
    const existing = await this.prisma.r4PlatformGrant.findUnique({
      where: { workflowRunId: request.workflowRunId },
    });
    if (existing) return this.replay(existing, request, now);

    const iat = Math.floor(now / 1000);
    const ttl = this.config.R4_PLATFORM_GRANT_TTL_SECONDS;
    const exp = iat + ttl;
    const jti = randomUUID();
    const token = await new SignJWT({
      schema_version: PLATFORM_GRANT_SCHEMA,
      authority_kind: 'PLATFORM_GRANT',
      purpose: request.purpose,
      subject_type: 'schedule',
      subject_id: request.scheduleId,
      schedule_id: request.scheduleId,
      schedule_request_sha256: request.scheduleRequestSha256,
      workflow_id: request.workflowId,
      workflow_run_id: request.workflowRunId,
      technical_policy_revision: request.technicalPolicyRevision,
      currency: 'USD',
      unit: 'microusd',
      // 引擎校验器要求规范十进制字符串（assertCanonicalMicrousd / nullablePositiveBigInt），
      // JSON 数字会被判 EXECUTION_BUDGET_GRANT_INVALID（2026-11-01 首次真实准入踩到）
      cap_per_run_microusd: request.capPerRunMicrousd,
      campaign_cap_microusd: request.campaignCapMicrousd,
      max_runs: '1',
    })
      .setProtectedHeader({ alg: 'RS256', kid: this.config.ENGINE_BUDGET_GRANT_KEY_ID, typ: PLATFORM_GRANT_TYPE })
      .setIssuer(this.config.ENGINE_BUDGET_GRANT_ISSUER)
      .setAudience(PLATFORM_GRANT_AUDIENCE)
      .setJti(jti)
      .setIssuedAt(iat)
      .setNotBefore(iat)
      .setExpirationTime(exp)
      .sign(await this.key());

    const tokenSha256 = (await import('node:crypto')).createHash('sha256').update(token).digest('hex');
    try {
      await this.prisma.r4PlatformGrant.create({
        data: {
          jti,
          purpose: request.purpose,
          scheduleId: request.scheduleId,
          workflowId: request.workflowId,
          workflowRunId: request.workflowRunId,
          scheduleRequestSha256: request.scheduleRequestSha256,
          technicalPolicyRevision: request.technicalPolicyRevision,
          capPerRunMicrousd: BigInt(request.capPerRunMicrousd),
          campaignCapMicrousd: BigInt(request.campaignCapMicrousd),
          maxRuns: 1n,
          issuedAt: new Date(iat * 1000),
          expiresAt: new Date(exp * 1000),
          token,
          tokenSha256,
        },
      });
    } catch (error) {
      // 并发重试：另一个请求已为同一 run 落库，返回它签发的那张
      if ((error as { code?: string }).code === 'P2002') {
        const winner = await this.prisma.r4PlatformGrant.findUnique({
          where: { workflowRunId: request.workflowRunId },
        });
        if (winner) return this.replay(winner, request, now);
      }
      throw error;
    }
    return { token, expiresAt: exp };
  }

  /** 同一 run 的重试拿回同一张 JWS；已过期则明确拒绝（不重签，v2 只认一把）。 */
  private replay(
    stored: { workflowRunId: string; scheduleRequestSha256: string; technicalPolicyRevision: string; token: string; expiresAt: Date },
    request: PlatformGrantRequest,
    now: number,
  ): IssuedPlatformGrant {
    if (
      stored.scheduleRequestSha256 !== request.scheduleRequestSha256 ||
      stored.technicalPolicyRevision !== request.technicalPolicyRevision
    )
      throw new PlatformGrantRejected('PLATFORM_GRANT_REUSE_MISMATCH', '同一运行的绑定与已签发 Grant 不一致');
    if (stored.expiresAt.getTime() <= now)
      throw new PlatformGrantRejected('PLATFORM_GRANT_REPLAY_EXPIRED', '已签发的 Grant 已过期，运行需要重新发起');
    return { token: stored.token, expiresAt: Math.floor(stored.expiresAt.getTime() / 1000) };
  }
}

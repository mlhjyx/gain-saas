import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PLATFORM_SCHEDULES, type PlatformScheduleId } from './contracts/r4-wire-contracts.js';

/**
 * 平台撤销的签发（P4）。
 *
 * 契约来自后端 `packages/contracts/src/platform-authority/revocation.ts`：
 *  - header 恰好 alg/kid/typ；typ = execution-budget-authority-revocation+jwt
 *  - payload 严格（.strict()）：schema_version / iss / aud / revocation_jti /
 *    target_issuer / target_jti / schedule_id / workflow_run_id / fence_sequence /
 *    reason_code / iat / nbf / exp
 *  - iss 必须等于 target_issuer；exp - iat ≤ 300 秒
 *  - 请求体是 compact JWS、content-type application/jose、≤16KB
 *  - 响应是后端已提交的 ACK（fence-ack+jwt），重放同一条请求返回原 ACK
 */

export const REVOCATION_TYPE = 'execution-budget-authority-revocation+jwt';
export const REVOCATION_AUDIENCE = 'global-backend:execution-budget';
export const REVOCATION_SCHEMA_VERSION = 'PlatformExecutionBudgetAuthorityRevoked/v1';

export const REVOCATION_REASON_CODES = [
  'POLICY_DISABLED',
  'SECURITY_RESPONSE',
  'OPERATOR_HOLD',
] as const;
export type RevocationReasonCode = (typeof REVOCATION_REASON_CODES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POSITIVE_DECIMAL = /^(0|[1-9][0-9]*)$/;

export interface RevocationCommand {
  scheduleId: PlatformScheduleId;
  workflowRunId: string;
  fenceSequence: string;
  reasonCode: RevocationReasonCode;
  /** 目标签发者；必须与 issuer 相同（后端强校验）。 */
  targetIssuer: string;
  /**
   * 被撤销 authority 的 jti：后端 fence 按 (issuer, jti) 精确匹配已 committed 的
   * PLATFORM_GRANT 行，必须取自已落库的 `r4_platform_grant`（`workflowRunId` 对应
   * 那一行）；随机或占位的 jti 永远命中不到，会得到 NOT_FOUND 而不是提交 fence。
   */
  targetJti: string;
}

@Injectable()
export class RevocationIssuer {
  private privateKey?: CryptoKey;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * 签名钥必须是**执行预算 Grant 钥**（`ENGINE_BUDGET_GRANT_*`，即
   * `/.well-known/execution-budget-jwks.json` 的那把）：引擎的撤销验签器
   * 只对第一份信任文档（EXECUTION_BUDGET_GRANT_JWKS_URI）里的 kid 解析公钥，
   * 用 R4 的 capability 族签会被判 PLATFORM_REVOCATION_VERIFICATION_UNAVAILABLE。
   */
  private async key(): Promise<CryptoKey> {
    this.privateKey ??= await importPKCS8(this.config.ENGINE_BUDGET_GRANT_PRIVATE_KEY, 'RS256');
    return this.privateKey;
  }

  async issue(command: RevocationCommand, now = Date.now()): Promise<string> {
    this.validate(command);
    const iat = Math.floor(now / 1000);
    const exp = iat + Math.min(this.config.R4_REVOCATION_TTL_SECONDS, 300);
    const key = await this.key();
    const kid = this.config.ENGINE_BUDGET_GRANT_KEY_ID;

    return new SignJWT({
      schema_version: REVOCATION_SCHEMA_VERSION,
      revocation_jti: randomUUID(),
      target_issuer: command.targetIssuer,
      target_jti: command.targetJti,
      schedule_id: command.scheduleId,
      workflow_run_id: command.workflowRunId,
      fence_sequence: command.fenceSequence,
      reason_code: command.reasonCode,
    })
      .setProtectedHeader({ alg: 'RS256', kid, typ: REVOCATION_TYPE })
      .setIssuer(command.targetIssuer)
      .setAudience(REVOCATION_AUDIENCE)
      .setIssuedAt(iat)
      .setNotBefore(iat)
      .setExpirationTime(exp)
      .sign(key);
  }

  private validate(command: RevocationCommand): void {
    if (!PLATFORM_SCHEDULES.includes(command.scheduleId))
      throw new Error(`未知 schedule: ${command.scheduleId}`);
    if (!UUID.test(command.workflowRunId)) throw new Error('workflowRunId 必须是 UUID');
    if (!UUID.test(command.targetJti)) throw new Error('targetJti 必须是 UUID');
    if (!POSITIVE_DECIMAL.test(command.fenceSequence) || command.fenceSequence === '0')
      throw new Error('fenceSequence 必须是正十进制字符串');
    if (!REVOCATION_REASON_CODES.includes(command.reasonCode))
      throw new Error(`未知 reason_code: ${command.reasonCode}`);
    if (command.targetIssuer.length === 0 || command.targetIssuer.length > 2048)
      throw new Error('targetIssuer 长度非法');
    let uri: URL;
    try {
      uri = new URL(command.targetIssuer);
    } catch {
      throw new Error('targetIssuer 必须是 URL');
    }
    if (uri.protocol !== 'https:' && !(uri.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(uri.hostname)))
      throw new Error('targetIssuer 必须是 https（或回环 http）');
    if (uri.username || uri.password || uri.search || uri.hash)
      throw new Error('targetIssuer 不得带凭据/查询/片段');
  }
}

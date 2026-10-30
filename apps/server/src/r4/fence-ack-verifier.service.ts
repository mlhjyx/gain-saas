import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWK } from 'jose';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';

/**
 * 验证后端返回的撤销 ACK（P5）。
 *
 * 契约来自 `packages/contracts/src/platform-authority/revocation.ts` 的
 * PlatformAuthorityFenceAckClaimsSchema：
 *  - typ = platform-authority-fence-ack+jwt
 *  - aud = growthos:platform-authority-fence-ack
 *  - 必须绑定本次请求：revocation_jti 相同、command_sha256 等于请求体的 SHA-256
 *  - committed_at ≤ iat；exp - iat ≤ 300
 *
 * ACK 的验签钥来自后端自己的 `/.well-known` 端点（fence-ack-jwks），
 * 与撤销签发钥完全不同族。
 */

export const FENCE_ACK_TYPE = 'platform-authority-fence-ack+jwt';
export const FENCE_ACK_AUDIENCE = 'growthos:platform-authority-fence-ack';
export const FENCE_ACK_JWKS_PATH = '/api/v1/platform-authority/fence-ack-jwks';

export interface ExpectedAck {
  revocationJti: string;
  commandJws: string;
  scheduleId: string;
  fenceSequence: string;
}

export class FenceAckInvalid extends Error {
  constructor(readonly reason: string) {
    super(`fence-ack invalid: ${reason}`);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

@Injectable()
export class FenceAckVerifier {
  private jwks?: { keys: JWK[]; fetchedAt: number };

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** 收取后端的 fence-ack 公钥；缓存 5 分钟，避免每次撤销都多一跳。 */
  private async keys(): Promise<ReturnType<typeof createLocalJWKSet>> {
    const base = this.config.R4_BACKEND_BASE_URL;
    if (!base) throw new FenceAckInvalid('未配置后端基址');
    const now = Date.now();
    if (!this.jwks || now - this.jwks.fetchedAt > 5 * 60_000) {
      const response = await fetch(new URL(FENCE_ACK_JWKS_PATH, base));
      if (!response.ok) throw new FenceAckInvalid(`JWKS 获取失败: ${response.status}`);
      const body = (await response.json()) as { keys?: JWK[] };
      if (!Array.isArray(body.keys) || body.keys.length === 0)
        throw new FenceAckInvalid('JWKS 为空');
      this.jwks = { keys: body.keys, fetchedAt: now };
    }
    return createLocalJWKSet({ keys: this.jwks.keys });
  }

  async verify(ackJws: string, expected: ExpectedAck, now = Date.now()): Promise<Record<string, unknown>> {
    if (ackJws.split('.').length !== 3) throw new FenceAckInvalid('不是 compact JWS');
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(ackJws);
    } catch {
      throw new FenceAckInvalid('header 无法解析');
    }
    if (Object.keys(header).sort().join(',') !== 'alg,kid,typ' || header.alg !== 'RS256')
      throw new FenceAckInvalid('header 不是 alg/kid/typ + RS256');
    if (header.typ !== FENCE_ACK_TYPE) throw new FenceAckInvalid('typ 不符');

    const issuer = this.config.R4_FENCE_ACK_ISSUER;
    if (!issuer) throw new FenceAckInvalid('未配置 fence-ack issuer');

    let claims: Record<string, unknown>;
    try {
      const result = await jwtVerify(ackJws, await this.keys(), {
        issuer,
        audience: FENCE_ACK_AUDIENCE,
        currentDate: new Date(now),
      });
      claims = result.payload as Record<string, unknown>;
    } catch (error) {
      throw new FenceAckInvalid(`验签失败: ${(error as Error).message}`);
    }

    const commandSha256 = createHash('sha256').update(expected.commandJws, 'utf8').digest('hex');
    if (claims.schema_version !== 'PlatformExecutionBudgetFenceAcknowledged/v1')
      throw new FenceAckInvalid('schema_version 不符');
    if (claims.revocation_jti !== expected.revocationJti) throw new FenceAckInvalid('revocation_jti 不匹配');
    if (claims.command_sha256 !== commandSha256) throw new FenceAckInvalid('command_sha256 与请求体不匹配');
    if (claims.schedule_id !== expected.scheduleId) throw new FenceAckInvalid('schedule_id 不匹配');
    if (claims.fence_sequence !== expected.fenceSequence) throw new FenceAckInvalid('fence_sequence 不匹配');
    const iat = claims.iat;
    const exp = claims.exp;
    const committedAt = claims.committed_at;
    if (!Number.isInteger(iat) || !Number.isInteger(exp) || !Number.isInteger(committedAt))
      throw new FenceAckInvalid('时间字段不是整数');
    if ((exp as number) - (iat as number) > 300) throw new FenceAckInvalid('时间窗口超过 300 秒');
    if ((committedAt as number) > (iat as number)) throw new FenceAckInvalid('committed_at 晚于 iat');
    for (const key of ['jti', 'revocation_jti']) {
      if (typeof claims[key] !== 'string' || !UUID.test(claims[key] as string))
        throw new FenceAckInvalid(`${key} 不是 UUID`);
    }
    for (const key of ['fence_sequence', 'backend_generation', 'in_flight_attempts']) {
      if (typeof claims[key] !== 'string' || !DECIMAL.test(claims[key] as string))
        throw new FenceAckInvalid(`${key} 不是十进制字符串`);
    }
    return claims;
  }
}

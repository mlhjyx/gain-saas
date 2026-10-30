import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';

/**
 * 把撤销投递到后端（P4）。
 *
 * 传输契约（apps/api/src/platform-authority/platform-revocation-http.contract.ts）：
 *  - POST /api/v1/platform-authority/revocations
 *  - content-type: application/jose；body 是 compact JWS；不得带 authorization/cookie
 *  - 请求体 ≤16KB，响应 ≤16KB；后端整体时限 25 秒
 *  - 200 返回**原始已提交 ACK**（重放同一请求得到同一条 ACK，不会重新签名）
 *  - 409 EXPIRED / REUSED / SEQUENCE_CONFLICT，429 限流，503 不可用
 */

export const REVOCATION_PATH = '/api/v1/platform-authority/revocations';
export const REVOCATION_MAX_BYTES = 16_384;
export const REVOCATION_DEADLINE_MS = 25_000;

export interface RevocationAck {
  /** 后端返回的原始 ACK JWS（未验签；验签在 P5 用 fence-ack JWKS 完成）。 */
  ack: string;
}

export class RevocationDeliveryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`revocation delivery failed: ${status} ${code}`);
  }
}

@Injectable()
export class RevocationClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async deliver(jws: string): Promise<RevocationAck> {
    const base = this.config.R4_BACKEND_BASE_URL;
    if (!base) throw new RevocationDeliveryError(503, 'R4_BACKEND_NOT_CONFIGURED');
    if (Buffer.byteLength(jws) > REVOCATION_MAX_BYTES)
      throw new RevocationDeliveryError(400, 'PLATFORM_REVOCATION_REQUEST_INVALID');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REVOCATION_DEADLINE_MS);
    try {
      const response = await fetch(new URL(REVOCATION_PATH, base), {
        method: 'POST',
        headers: { 'content-type': 'application/jose', accept: 'application/jose' },
        body: jws,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        let code = 'PLATFORM_REVOCATION_UNAVAILABLE';
        try {
          const parsed = JSON.parse(text) as { error?: { code?: string } };
          if (parsed.error?.code) code = parsed.error.code;
        } catch {
          /* 非 JSON 错误体：保留默认码 */
        }
        throw new RevocationDeliveryError(response.status, code);
      }
      if (Buffer.byteLength(text) > REVOCATION_MAX_BYTES || text.split('.').length !== 3)
        throw new RevocationDeliveryError(502, 'PLATFORM_REVOCATION_ACK_INVALID');
      return { ack: text };
    } finally {
      clearTimeout(timer);
    }
  }
}

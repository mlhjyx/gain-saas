import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EngineHttp } from '../bff/engine-http.js';
import type { OutreachTenant } from './outreach-consent.service.js';

export interface OutreachDncChecker {
  /** Returns canonical email → suppression reasons; absent = not suppressed. */
  check(
    tenant: OutreachTenant,
    emails: readonly string[],
  ): Promise<Map<string, string[]>>;
}

/**
 * gain-saas 侧的 DNC 预检：调用引擎 `POST /outreach/dnc/check`（同时查租户
 * suppression_record 与平台全局抑制）。引擎返回邮箱哈希，这里按本地规范化
 * （trim + lowercase）还原为邮箱键；无法规范化的地址由调用方先行拒绝。
 */
@Injectable()
export class EngineOutreachDncChecker implements OutreachDncChecker {
  constructor(private readonly engine: EngineHttp) {}

  async check(
    tenant: OutreachTenant,
    emails: readonly string[],
  ): Promise<Map<string, string[]>> {
    if (emails.length === 0) return new Map();
    const result = await this.engine.call(tenant, 'POST', '/outreach/dnc/check', {
      body: { emails },
      timeoutMs: 10_000,
    });
    const body = result.body as {
      data?: { results?: Array<{ emailHash?: unknown; reasons?: unknown }> };
    };
    const rows = Array.isArray(body?.data?.results) ? body.data.results : [];
    const byHash = new Map<string, string[]>();
    for (const row of rows) {
      if (typeof row.emailHash !== 'string') continue;
      const reasons = Array.isArray(row.reasons)
        ? row.reasons.filter((reason): reason is string => typeof reason === 'string')
        : [];
      byHash.set(row.emailHash, reasons);
    }
    const out = new Map<string, string[]>();
    for (const email of emails) {
      const canonical = email.trim().toLowerCase();
      const reasons =
        byHash.get(createHash('sha256').update(canonical).digest('hex')) ?? [];
      if (reasons.length > 0) out.set(canonical, reasons);
    }
    return out;
  }
}

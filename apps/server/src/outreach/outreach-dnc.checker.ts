import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EngineHttp } from '../bff/engine-http.js';
import type { AppConfig } from '../config/configuration.js';
import { APP_CONFIG } from '../shared/config.module.js';
import type { OutreachTenant } from './outreach-consent.service.js';

export const OUTREACH_DNC_SUPPRESSOR = Symbol('OUTREACH_DNC_SUPPRESSOR');

export interface OutreachDncChecker {
  /** Returns canonical email → suppression reasons; absent = not suppressed. */
  check(
    tenant: OutreachTenant,
    emails: readonly string[],
  ): Promise<Map<string, string[]>>;
}

export interface OutreachDncSuppressor {
  /** 平台级抑制（跨租户）：只传邮箱与原因，引擎只落 SHA-256。 */
  suppressGlobal(
    tenant: OutreachTenant,
    input: { email: string; reason: 'unsubscribe' | 'bounce' | 'complaint'; source: string },
  ): Promise<void>;
}

/**
 * gain-saas 侧的 DNC 预检：调用引擎 `POST /outreach/dnc/check`（同时查租户
 * suppression_record 与平台全局抑制）。引擎返回邮箱哈希，这里按本地规范化
 * （trim + lowercase）还原为邮箱键；无法规范化的地址由调用方先行拒绝。
 */
@Injectable()
export class EngineOutreachDncChecker implements OutreachDncChecker, OutreachDncSuppressor {
  constructor(
    private readonly engine: EngineHttp,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async check(
    tenant: OutreachTenant,
    emails: readonly string[],
  ): Promise<Map<string, string[]>> {
    if (emails.length === 0) return new Map();
    const result = await this.engine.call(tenant, 'POST', '/outreach/dnc/check', {
      body: { emails },
      timeoutMs: 10_000,
    });
    // 合规门 fail closed：403/5xx 或畸形响应必须当成“无法确认”，不能当成“没命中”。
    if (result.status >= 400) {
      throw new Error(`DNC 检查失败（HTTP ${result.status}）`);
    }
    const body = result.body as {
      data?: { results?: Array<{ emailHash?: unknown; reasons?: unknown }> };
    };
    if (!Array.isArray(body?.data?.results)) {
      throw new Error('DNC 响应格式不合法：缺少 data.results');
    }
    const byHash = new Map<string, string[]>();
    for (const row of body.data.results) {
      if (typeof row.emailHash !== 'string' || !Array.isArray(row.reasons)) {
        throw new Error('DNC 响应格式不合法：条目缺少 emailHash/reasons');
      }
      byHash.set(
        row.emailHash,
        row.reasons.filter((reason): reason is string => typeof reason === 'string'),
      );
    }
    const out = new Map<string, string[]>();
    for (const email of emails) {
      const canonical = email.trim().toLowerCase();
      const hash = createHash('sha256').update(canonical).digest('hex');
      const reasons = byHash.get(hash);
      if (!reasons) {
        throw new Error(`DNC 响应缺少邮箱条目（${hash.slice(0, 8)}…）`);
      }
      if (reasons.length > 0) out.set(canonical, reasons);
    }
    return out;
  }

  async suppressGlobal(
    tenant: OutreachTenant,
    input: { email: string; reason: 'unsubscribe' | 'bounce' | 'complaint'; source: string },
  ): Promise<void> {
    const serviceToken = this.config.OUTREACH_ENGINE_SERVICE_TOKEN;
    if (!serviceToken) {
      throw new Error(
        'OUTREACH_ENGINE_SERVICE_TOKEN 未配置，平台级抑制未写入（租户内退订已生效）',
      );
    }
    const result = await this.engine.call(tenant, 'POST', '/outreach/dnc/suppress', {
      body: input,
      headers: { 'x-service-token': serviceToken },
      timeoutMs: 10_000,
    });
    if (result.status >= 400) {
      throw new Error(`平台抑制写入失败（HTTP ${result.status}）`);
    }
  }
}

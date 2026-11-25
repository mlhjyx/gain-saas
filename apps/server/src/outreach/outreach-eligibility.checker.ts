import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { EngineHttp } from '../bff/engine-http.js';
import type { AppConfig } from '../config/configuration.js';
import { APP_CONFIG } from '../shared/config.module.js';
import type { OutreachTenant } from './outreach-consent.service.js';

export const OUTREACH_ELIGIBILITY_CHECKER = Symbol('OUTREACH_ELIGIBILITY_CHECKER');

/** 引擎四态（discovery/contact-point-verification-state.ts）。 */
export type EngineEligibilityState = 'VALID' | 'INVALID' | 'CATCH_ALL_RISKY' | 'UNKNOWN';

export type EngineRecommendedChannel = 'email' | 'linkedin_first' | 'manual_review';

export interface EngineEligibilityD3Policy {
  emailPolicy: string;
  emailAllowedNow: boolean;
  complianceTag: string;
  requiresArticle14Notice: boolean;
  recommendedSequence: string[];
}

export interface EngineEligibilityResult {
  found: boolean;
  state: EngineEligibilityState;
  score: number | null;
  /** 仅 state==='VALID' 且合规允许时含 'outreach'——发送门以此为唯一放行依据（fail-closed）。 */
  allowedActions: string[];
  /** Batch 1.4-C：Catch-All 且有领英或 D3 严格法域时引擎建议 linkedin_first。 */
  recommendedChannel?: EngineRecommendedChannel;
  /** Batch 1.4-C：引擎侧 D3 法域多通道合规裁决（旧镜像不返回时为 undefined）。 */
  d3Policy?: EngineEligibilityD3Policy | null;
}

export interface OutreachEligibilityChecker {
  /**
   * 引擎联系人可触达性预检（P1-16）：canonical email → 结果；缺失条目视为
   * found=false（引擎不可达/畸形响应由实现抛错，调用方整批 fail-closed）。
   */
  check(
    tenant: OutreachTenant,
    emails: readonly string[],
  ): Promise<Map<string, EngineEligibilityResult>>;
}

const ELIGIBILITY_MAX_EMAILS = 50; // 引擎 OUTREACH_ELIGIBILITY_BATCH_TOO_LARGE 上限

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 发送前可投递性预检（缺口 3）：调用引擎 `POST /outreach/contact-eligibility`
 * （服务令牌 = OUTREACH_ENGINE_SERVICE_TOKEN，与 DNC suppress 同一枚）。
 * 引擎按规范化密文等值匹配 contact_point，返回四态与 allowedActions；
 * 引擎文档明示接线语义：不可达时调用方 fail closed。
 */
@Injectable()
export class EngineContactEligibilityChecker implements OutreachEligibilityChecker {
  constructor(
    private readonly engine: EngineHttp,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async check(
    tenant: OutreachTenant,
    emails: readonly string[],
  ): Promise<Map<string, EngineEligibilityResult>> {
    if (emails.length === 0) return new Map();
    const canonical = [...new Set(emails.map((email) => email.trim().toLowerCase()))].filter(
      (email) => EMAIL_RE.test(email),
    );
    const out = new Map<string, EngineEligibilityResult>();
    // 引擎单批 ≤50：分块串行（批内几十封，最多两三块）
    for (let i = 0; i < canonical.length; i += ELIGIBILITY_MAX_EMAILS) {
      const chunk = canonical.slice(i, i + ELIGIBILITY_MAX_EMAILS);
      const result = await this.engine.call(tenant, 'POST', '/outreach/contact-eligibility', {
        // 引擎 DTO 必填 workspaceId(ValidationPipe whitelist → 缺失即 400)
        body: { workspaceId: tenant.workspaceId, emails: chunk },
        headers: { 'x-service-token': this.config.OUTREACH_ENGINE_SERVICE_TOKEN ?? '' },
        timeoutMs: 10_000,
      });
      if (result.status >= 400) {
        throw new Error(`可触达性检查失败（HTTP ${result.status}）`);
      }
      const body = result.body as { data?: { results?: unknown } };
      if (!Array.isArray(body?.data?.results)) {
        throw new Error('可触达性响应格式不合法：缺少 data.results');
      }
      const byHash = new Map<string, EngineEligibilityResult>();
      for (const row of body.data.results as Array<Record<string, unknown>>) {
        if (typeof row.emailHash !== 'string') {
          throw new Error('可触达性响应格式不合法：条目缺少 emailHash');
        }
        const recChannel =
          row.recommendedChannel === 'email' ||
          row.recommendedChannel === 'linkedin_first' ||
          row.recommendedChannel === 'manual_review'
            ? row.recommendedChannel
            : undefined;
        const d3Raw = row.d3Policy && typeof row.d3Policy === 'object' ? (row.d3Policy as Record<string, unknown>) : null;
        const d3Policy: EngineEligibilityD3Policy | null | undefined =
          row.d3Policy === null
            ? null
            : d3Raw && typeof d3Raw.emailPolicy === 'string' && typeof d3Raw.complianceTag === 'string'
              ? {
                  emailPolicy: d3Raw.emailPolicy,
                  emailAllowedNow: d3Raw.emailAllowedNow === true,
                  complianceTag: d3Raw.complianceTag,
                  requiresArticle14Notice: d3Raw.requiresArticle14Notice === true,
                  recommendedSequence: Array.isArray(d3Raw.recommendedSequence)
                    ? d3Raw.recommendedSequence.filter((s): s is string => typeof s === 'string')
                    : [],
                }
              : undefined;
        byHash.set(row.emailHash, {
          found: row.found === true,
          state: (row.state as EngineEligibilityState) ?? 'UNKNOWN',
          score: typeof row.score === 'number' ? row.score : null,
          allowedActions: Array.isArray(row.allowedActions)
            ? row.allowedActions.filter((a): a is string => typeof a === 'string')
            : [],
          ...(recChannel !== undefined ? { recommendedChannel: recChannel } : {}),
          ...(d3Policy !== undefined ? { d3Policy } : {}),
        });
      }
      for (const email of chunk) {
        // 与引擎同口径：trim+lowercase 后 sha256（IDN 域名的 punycode 差异会导致
        // 未命中 → found=false → 拒发，fail-closed 方向，安全）
        const hash = createHash('sha256').update(email).digest('hex');
        // 未命中条目 = 引擎里没有这个联系点 → found=false（调用方按拒发处理）
        out.set(email, byHash.get(hash) ?? { found: false, state: 'UNKNOWN', score: null, allowedActions: [] });
      }
    }
    return out;
  }
}

import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SignJWT, importPKCS8 } from 'jose';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import { bindingInstant } from './platform-facts.service.js';
import { PlatformPolicyStateService } from './platform-policy-state.service.js';

/**
 * 平台渠道抓取 Grant 的持久签发（P4-P3，purpose `platform.channel_crawl`）。
 *
 * 与 schedule Grant（platform-grant.service.ts）共用同一把执行预算钥族与
 * 受众，但 claim 形状是引擎 P4-P1 定义的 channel-crawl 分支：
 *  - subject_type = source_channel，subject_id = channelId；schedule 四字段缺席
 *  - request_sha256 = sha256(canonical {channelId, mode, pageCap})（一次性绑定）
 *  - crawl_run_id 绑定一次抓取运行；technical_policy_revision 必须等于权威
 *    持有的 v3 工件 channel_crawl 小节摘要（配置注入）
 *
 * 权威侧硬执行：单轮页数上限 50（preview 固定 1 页）、单渠道 UTC 日累计页数
 * 上限 500（按已签发 Grant 的 page_cap 对账——引擎侧再按 source_channel_run
 * 实际页数二次执行）、单轮金额不超过配置上限、部署绑定未撤销未过期、任一
 * egress schedule 处于 DISABLED 时拒绝签发（平台级保守门）。
 * 默认关闭（R4_CHANNEL_CRAWL_GRANT_ENABLED=false），运营显式开启才签发。
 */

export const CHANNEL_CRAWL_GRANT_TYPE = 'execution-budget-grant+jwt';
export const CHANNEL_CRAWL_GRANT_SCHEMA = 'execution-budget-grant/v1';
export const CHANNEL_CRAWL_GRANT_AUDIENCE = 'global-backend:execution-budget';
export const CHANNEL_CRAWL_PURPOSE = 'platform.channel_crawl';
export const CHANNEL_CRAWL_RUN_MAX_PAGES = 50n;
export const CHANNEL_CRAWL_DAILY_PAGE_CAP = 500n;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL = /^[1-9][0-9]*$/;
const MODES = ['preview', 'run', 'refresh'] as const;

export type ChannelCrawlMode = (typeof MODES)[number];

export class ChannelCrawlGrantRejected extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface ChannelCrawlGrantRequest {
  channelId: string;
  mode: string;
  pageCap: string;
  crawlRunId: string;
  requestSha256: string;
  technicalPolicyRevision: string;
  capPerRunMicrousd: string;
  campaignCapMicrousd: string;
}

export interface IssuedChannelCrawlGrant {
  token: string;
  expiresAt: number;
}

/**
 * request_sha256 的规范预像：键排序的紧凑 JSON，UTF-8 无换行。
 * 引擎 P4-P4 侧必须用同一构造；两侧测试用同一组向量锁定。
 */
export function channelCrawlRequestSha256(
  channelId: string,
  mode: string,
  pageCap: string,
): string {
  const canonical = `{"channelId":${JSON.stringify(channelId)},"mode":${JSON.stringify(mode)},"pageCap":${JSON.stringify(pageCap)}}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function startOfUtcDay(now: number): Date {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

@Injectable()
export class PlatformCrawlGrantIssuer {
  private privateKey?: CryptoKey;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    // 平台策略镜像可选：单测直接构造时不注入；Nest 下由 R4Module 提供。
    @Optional()
    @Inject(PlatformPolicyStateService)
    private readonly policy?: Pick<PlatformPolicyStateService, 'configuredModes'> | null,
  ) {}

  private async key(): Promise<CryptoKey> {
    this.privateKey ??= await importPKCS8(this.config.ENGINE_BUDGET_GRANT_PRIVATE_KEY, 'RS256');
    return this.privateKey;
  }

  private expectedRevision(): string {
    const expected = this.config.R4_CHANNEL_CRAWL_EXPECTED_TECHNICAL_POLICY_REVISION;
    if (!expected) {
      throw new ChannelCrawlGrantRejected(
        'PLATFORM_GRANT_CONFIGURATION_INVALID',
        '未配置渠道抓取策略副本（R4_CHANNEL_CRAWL_EXPECTED_TECHNICAL_POLICY_REVISION）',
      );
    }
    return expected;
  }

  private capCeiling(): bigint {
    const raw = this.config.R4_CHANNEL_CRAWL_MAX_CAP_MICROUSD;
    if (!raw || !DECIMAL.test(raw)) {
      throw new ChannelCrawlGrantRejected(
        'PLATFORM_GRANT_CONFIGURATION_INVALID',
        '未配置渠道抓取金额上限（R4_CHANNEL_CRAWL_MAX_CAP_MICROUSD）',
      );
    }
    return BigInt(raw);
  }

  /** 部署绑定只证明部署身份与有效期；渠道抓取不绑定 scheduleActions。 */
  private assertBindingValid(now: number): void {
    const file = this.config.R4_DEPLOYMENT_BINDING_FILE;
    if (!file) {
      throw new ChannelCrawlGrantRejected('PLATFORM_GRANT_BINDING_UNAVAILABLE', '未配置部署绑定文件');
    }
    let binding: { validUntil?: unknown; revokedAt?: unknown };
    try {
      binding = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new ChannelCrawlGrantRejected('PLATFORM_GRANT_BINDING_UNAVAILABLE', '部署绑定不可读');
    }
    const revokedAt = bindingInstant(binding.revokedAt);
    if (Number.isFinite(revokedAt)) {
      throw new ChannelCrawlGrantRejected('PLATFORM_GRANT_BINDING_REVOKED', '部署绑定已被显式撤销');
    }
    const validUntil =
      typeof binding.validUntil === 'number'
        ? binding.validUntil
        : typeof binding.validUntil === 'string'
          ? Date.parse(binding.validUntil)
          : Number.NaN;
    if (Number.isNaN(validUntil) || validUntil <= now) {
      throw new ChannelCrawlGrantRejected('PLATFORM_GRANT_BINDING_UNAVAILABLE', '部署绑定已过期');
    }
  }

  /** 任一 egress schedule 处于 DISABLED 时平台出网整体保守拒绝新抓取。 */
  private assertPolicyOpen(): void {
    if (!this.policy) return;
    let modes: Array<{ mode: string }>;
    try {
      modes = this.policy.configuredModes();
    } catch {
      throw new ChannelCrawlGrantRejected(
        'PLATFORM_GRANT_CONFIGURATION_INVALID',
        '平台策略镜像配置不可用',
      );
    }
    if (modes.some((entry) => entry.mode !== 'ENABLED')) {
      throw new ChannelCrawlGrantRejected(
        'PLATFORM_CHANNEL_CRAWL_POLICY_BLOCKED',
        '平台策略停用期间不签发渠道抓取 Grant',
      );
    }
  }

  private validate(request: ChannelCrawlGrantRequest): void {
    if (!UUID.test(request.channelId)) {
      throw new ChannelCrawlGrantRejected('PLATFORM_GRANT_REQUEST_INVALID', 'channelId 非法');
    }
    if (!MODES.includes(request.mode as ChannelCrawlMode)) {
      throw new ChannelCrawlGrantRejected('PLATFORM_GRANT_REQUEST_INVALID', 'mode 必须是 preview/run/refresh');
    }
    if (!UUID.test(request.crawlRunId)) {
      throw new ChannelCrawlGrantRejected('PLATFORM_GRANT_REQUEST_INVALID', 'crawlRunId 非法');
    }
    if (!DECIMAL.test(request.pageCap)) {
      throw new ChannelCrawlGrantRejected('PLATFORM_GRANT_REQUEST_INVALID', 'pageCap 必须是正十进制字符串');
    }
    const pageCap = BigInt(request.pageCap);
    if (request.mode === 'preview') {
      if (pageCap !== 1n) {
        throw new ChannelCrawlGrantRejected('PLATFORM_GRANT_REQUEST_INVALID', 'preview 固定 1 页');
      }
    } else if (pageCap > CHANNEL_CRAWL_RUN_MAX_PAGES) {
      throw new ChannelCrawlGrantRejected(
        'PLATFORM_GRANT_CAP_EXCEEDED',
        `单轮页数超过上限 ${CHANNEL_CRAWL_RUN_MAX_PAGES}`,
      );
    }
    if (request.requestSha256 !== channelCrawlRequestSha256(request.channelId, request.mode, request.pageCap)) {
      throw new ChannelCrawlGrantRejected(
        'PLATFORM_GRANT_REQUEST_MISMATCH',
        'requestSha256 与 channelId/mode/pageCap 的规范摘要不一致',
      );
    }
    if (request.technicalPolicyRevision !== this.expectedRevision()) {
      throw new ChannelCrawlGrantRejected(
        'PLATFORM_GRANT_REQUEST_MISMATCH',
        'technicalPolicyRevision 与权威策略副本不一致',
      );
    }
    if (!DECIMAL.test(request.capPerRunMicrousd) || !DECIMAL.test(request.campaignCapMicrousd)) {
      throw new ChannelCrawlGrantRejected('PLATFORM_GRANT_REQUEST_INVALID', '金额必须是正十进制字符串');
    }
    const capPerRun = BigInt(request.capPerRunMicrousd);
    const campaignCap = BigInt(request.campaignCapMicrousd);
    if (campaignCap < capPerRun) {
      throw new ChannelCrawlGrantRejected('PLATFORM_GRANT_REQUEST_INVALID', 'campaign 上限不得低于单轮上限');
    }
    const ceiling = this.capCeiling();
    if (capPerRun > ceiling || campaignCap > ceiling) {
      throw new ChannelCrawlGrantRejected('PLATFORM_GRANT_CAP_EXCEEDED', `超过渠道抓取金额上限: ${ceiling}`);
    }
  }

  /** 单渠道 UTC 日累计页数配额（按已签发 Grant 的 page_cap 对账）。 */
  private async assertDailyQuota(channelId: string, pageCap: bigint, now: number, replaying: boolean): Promise<void> {
    if (replaying) return;
    const dayStart = startOfUtcDay(now);
    const aggregate = await this.prisma.r4ChannelCrawlGrant.aggregate({
      _sum: { pageCap: true },
      where: { channelId, issuedAt: { gte: dayStart } },
    });
    const used = aggregate._sum.pageCap ?? 0n;
    if (used + pageCap > CHANNEL_CRAWL_DAILY_PAGE_CAP) {
      throw new ChannelCrawlGrantRejected(
        'PLATFORM_CHANNEL_CRAWL_DAILY_PAGE_EXCEEDED',
        `渠道当日页数配额不足（已授 ${used} / 上限 ${CHANNEL_CRAWL_DAILY_PAGE_CAP}）`,
      );
    }
  }

  async issue(request: ChannelCrawlGrantRequest, now = Date.now()): Promise<IssuedChannelCrawlGrant> {
    if (!this.config.R4_CHANNEL_CRAWL_GRANT_ENABLED) {
      throw new ChannelCrawlGrantRejected('PLATFORM_CHANNEL_CRAWL_DISABLED', '渠道抓取签发未开启');
    }
    this.validate(request);
    this.assertBindingValid(now);
    this.assertPolicyOpen();

    const existing = await this.prisma.r4ChannelCrawlGrant.findUnique({
      where: { crawlRunId: request.crawlRunId },
    });
    if (existing) return this.replay(existing, request, now);
    await this.assertDailyQuota(request.channelId, BigInt(request.pageCap), now, false);

    const iat = Math.floor(now / 1000);
    const ttl = this.config.R4_PLATFORM_GRANT_TTL_SECONDS;
    const exp = iat + ttl;
    const jti = randomUUID();
    const token = await new SignJWT({
      schema_version: CHANNEL_CRAWL_GRANT_SCHEMA,
      authority_kind: 'PLATFORM_GRANT',
      purpose: CHANNEL_CRAWL_PURPOSE,
      subject_type: 'source_channel',
      subject_id: request.channelId,
      request_sha256: request.requestSha256,
      crawl_run_id: request.crawlRunId,
      technical_policy_revision: request.technicalPolicyRevision,
      currency: 'USD',
      unit: 'microusd',
      cap_per_run_microusd: request.capPerRunMicrousd,
      campaign_cap_microusd: request.campaignCapMicrousd,
      max_runs: '1',
    })
      .setProtectedHeader({ alg: 'RS256', kid: this.config.ENGINE_BUDGET_GRANT_KEY_ID, typ: CHANNEL_CRAWL_GRANT_TYPE })
      .setIssuer(this.config.ENGINE_BUDGET_GRANT_ISSUER)
      .setAudience(CHANNEL_CRAWL_GRANT_AUDIENCE)
      .setJti(jti)
      .setIssuedAt(iat)
      .setNotBefore(iat)
      .setExpirationTime(exp)
      .sign(await this.key());
    const tokenSha256 = createHash('sha256').update(token).digest('hex');

    try {
      await this.prisma.r4ChannelCrawlGrant.create({
        data: {
          jti,
          purpose: CHANNEL_CRAWL_PURPOSE,
          channelId: request.channelId,
          mode: request.mode,
          pageCap: BigInt(request.pageCap),
          crawlRunId: request.crawlRunId,
          requestSha256: request.requestSha256,
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
      if ((error as { code?: string }).code === 'P2002') {
        const winner = await this.prisma.r4ChannelCrawlGrant.findUnique({
          where: { crawlRunId: request.crawlRunId },
        });
        if (winner) return this.replay(winner, request, now);
      }
      throw error;
    }
    return { token, expiresAt: exp };
  }

  /** 同一运行的重试拿回同一张 JWS；已过期则明确拒绝（不重签）。 */
  private replay(
    stored: { requestSha256: string; technicalPolicyRevision: string; token: string; expiresAt: Date },
    request: ChannelCrawlGrantRequest,
    now: number,
  ): IssuedChannelCrawlGrant {
    if (
      stored.requestSha256 !== request.requestSha256 ||
      stored.technicalPolicyRevision !== request.technicalPolicyRevision
    ) {
      throw new ChannelCrawlGrantRejected('PLATFORM_GRANT_REUSE_MISMATCH', '同一运行的绑定与已签发 Grant 不一致');
    }
    if (stored.expiresAt.getTime() <= now) {
      throw new ChannelCrawlGrantRejected('PLATFORM_GRANT_REPLAY_EXPIRED', '已签发的 Grant 已过期，运行需要重新发起');
    }
    return { token: stored.token, expiresAt: Math.floor(stored.expiresAt.getTime() / 1000) };
  }
}

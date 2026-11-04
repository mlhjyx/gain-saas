import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, decodeProtectedHeader, exportJWK, jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import {
  CHANNEL_CRAWL_DAILY_PAGE_CAP,
  ChannelCrawlGrantRejected,
  PlatformCrawlGrantIssuer,
  channelCrawlRequestSha256,
  type ChannelCrawlGrantRequest,
} from './platform-crawl-grant.service.js';

const NOW = 1_793_500_000_000;
const REVISION = 'e'.repeat(64);
const CHANNEL = '55555555-5555-4555-8555-555555555555';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function fixture(overrides: Partial<AppConfig> = {}, prismaOverrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'r4-crawl-grant-'));
  dirs.push(dir);
  const binding = join(dir, 'deployment-binding.json');
  writeFileSync(binding, JSON.stringify({ validUntil: NOW + 86_400_000 }));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const jwk = await exportJWK(createPublicKey(pem));
  const config = {
    ENGINE_BUDGET_GRANT_PRIVATE_KEY: pem,
    ENGINE_BUDGET_GRANT_KEY_ID: 'budget-test',
    ENGINE_BUDGET_GRANT_ISSUER: 'https://127.0.0.1:18446/execution-budget',
    R4_PLATFORM_GRANT_TTL_SECONDS: 300,
    R4_PLATFORM_GRANT_CLIENT_SUBJECT: 'global-backend-platform-worker',
    R4_DEPLOYMENT_BINDING_FILE: binding,
    R4_CHANNEL_CRAWL_GRANT_ENABLED: true,
    R4_CHANNEL_CRAWL_MAX_CAP_MICROUSD: '5000000',
    R4_CHANNEL_CRAWL_EXPECTED_TECHNICAL_POLICY_REVISION: REVISION,
    ...overrides,
  } as unknown as AppConfig;
  const findUnique = vi.fn().mockResolvedValue(null);
  const create = vi.fn().mockResolvedValue({});
  const aggregate = vi.fn().mockResolvedValue({ _sum: { pageCap: 0n } });
  const prisma = {
    r4ChannelCrawlGrant: { findUnique, create, aggregate },
    ...prismaOverrides,
  } as unknown as PrismaService;
  const issuer = new PlatformCrawlGrantIssuer(config, prisma);
  return {
    issuer,
    config,
    binding,
    findUnique,
    create,
    aggregate,
    pkJwks: { keys: [{ ...jwk, kid: 'budget-test', alg: 'RS256', use: 'sig' }] },
  };
}

function request(overrides: Partial<ChannelCrawlGrantRequest> = {}): ChannelCrawlGrantRequest {
  const base = {
    channelId: CHANNEL,
    mode: 'run',
    pageCap: '10',
    crawlRunId: randomUUID(),
    technicalPolicyRevision: REVISION,
    capPerRunMicrousd: '1000000',
    campaignCapMicrousd: '1000000',
    ...overrides,
  };
  return {
    ...base,
    requestSha256:
      overrides.requestSha256 ?? channelCrawlRequestSha256(base.channelId, base.mode, base.pageCap),
  };
}

async function rejection(operation: Promise<unknown>): Promise<string> {
  const error = await operation.catch((err: unknown) => err);
  expect(error).toBeInstanceOf(ChannelCrawlGrantRejected);
  return (error as ChannelCrawlGrantRejected).code;
}

describe('平台渠道抓取 Grant 签发（P4-P3）', () => {
  it('锁定跨仓共享的 request 规范摘要向量', () => {
    expect(channelCrawlRequestSha256(CHANNEL, 'preview', '1')).toBe(
      '870844370d9ae83fd096ab4c199376a53cda2cb5e87e32fc092dec00c4cae17d',
    );
  });

  it('默认关闭：未开启签发时返回 PLATFORM_CHANNEL_CRAWL_DISABLED', async () => {
    const { issuer } = await fixture({ R4_CHANNEL_CRAWL_GRANT_ENABLED: false });
    expect(await rejection(issuer.issue(request(), NOW))).toBe('PLATFORM_CHANNEL_CRAWL_DISABLED');
  });

  it('签发与引擎 P4-P1 契约完全一致的头与 claim 集合', async () => {
    const { issuer, pkJwks, create } = await fixture();
    const input = request();
    const issued = await issuer.issue(input, NOW);

    const header = decodeProtectedHeader(issued.token);
    expect(header).toEqual({ alg: 'RS256', kid: 'budget-test', typ: 'execution-budget-grant+jwt' });

    const { payload, protectedHeader } = await jwtVerify(
      issued.token,
      createLocalJWKSet(pkJwks),
      {
        issuer: 'https://127.0.0.1:18446/execution-budget',
        audience: 'global-backend:execution-budget',
        currentDate: new Date(NOW),
      },
    );
    expect(protectedHeader.typ).toBe('execution-budget-grant+jwt');
    expect(Object.keys(payload).sort()).toEqual([
      'aud',
      'authority_kind',
      'campaign_cap_microusd',
      'cap_per_run_microusd',
      'crawl_run_id',
      'currency',
      'exp',
      'iat',
      'iss',
      'jti',
      'max_runs',
      'nbf',
      'purpose',
      'request_sha256',
      'schema_version',
      'subject_id',
      'subject_type',
      'technical_policy_revision',
      'unit',
    ]);
    expect(payload).toMatchObject({
      schema_version: 'execution-budget-grant/v1',
      authority_kind: 'PLATFORM_GRANT',
      purpose: 'platform.channel_crawl',
      subject_type: 'source_channel',
      subject_id: CHANNEL,
      request_sha256: input.requestSha256,
      crawl_run_id: input.crawlRunId,
      technical_policy_revision: REVISION,
      currency: 'USD',
      unit: 'microusd',
      cap_per_run_microusd: '1000000',
      campaign_cap_microusd: '1000000',
      max_runs: '1',
    });
    expect(Number(payload.exp) - Number(payload.iat)).toBe(300);
    expect(issued.expiresAt).toBe(Math.floor(NOW / 1000) + 300);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          channelId: CHANNEL,
          crawlRunId: input.crawlRunId,
          pageCap: 10n,
          maxRuns: 1n,
        }),
      }),
    );
  });

  it.each([
    ['request 摘要不符', { requestSha256: 'f'.repeat(64) }, 'PLATFORM_GRANT_REQUEST_MISMATCH'],
    ['preview 页数非 1', { mode: 'preview', pageCap: '2' }, 'PLATFORM_GRANT_REQUEST_INVALID'],
    ['单轮超过 50 页', { pageCap: '51' }, 'PLATFORM_GRANT_CAP_EXCEEDED'],
    ['策略副本不符', { technicalPolicyRevision: 'f'.repeat(64) }, 'PLATFORM_GRANT_REQUEST_MISMATCH'],
    ['campaign 低于单轮', { campaignCapMicrousd: '999999' }, 'PLATFORM_GRANT_REQUEST_INVALID'],
    ['超过金额上限', { capPerRunMicrousd: '5000001', campaignCapMicrousd: '5000001' }, 'PLATFORM_GRANT_CAP_EXCEEDED'],
  ])('拒绝 %s', async (_label, overrides, code) => {
    const { issuer, create } = await fixture();
    expect(await rejection(issuer.issue(request(overrides), NOW))).toBe(code);
    expect(create).not.toHaveBeenCalled();
  });

  it('跳过 preview 页数检查对 run 不适用：run 页数 1..50 合法', async () => {
    const { issuer } = await fixture();
    await expect(issuer.issue(request({ pageCap: '50' }), NOW)).resolves.toMatchObject({
      expiresAt: expect.any(Number),
    });
  });

  it.each([
    ['绑定已撤销', { revokedAt: NOW - 1000 }, 'PLATFORM_GRANT_BINDING_REVOKED'],
    ['绑定已过期', { validUntil: NOW - 1000 }, 'PLATFORM_GRANT_BINDING_UNAVAILABLE'],
  ])('%s 时拒绝签发', async (_label, bindingPatch, code) => {
    const { issuer, binding } = await fixture();
    writeFileSync(binding, JSON.stringify({ validUntil: NOW + 86_400_000, ...bindingPatch }));
    expect(await rejection(issuer.issue(request(), NOW))).toBe(code);
  });

  it('单渠道 UTC 日页数配额硬执行（已授 490，再请求 10 恰好 500 通过，再 1 页拒绝）', async () => {
    const { issuer, aggregate } = await fixture();
    aggregate.mockResolvedValueOnce({ _sum: { pageCap: 490n } });
    await expect(issuer.issue(request({ pageCap: '10' }), NOW)).resolves.toBeDefined();
    aggregate.mockResolvedValueOnce({ _sum: { pageCap: CHANNEL_CRAWL_DAILY_PAGE_CAP } });
    expect(await rejection(issuer.issue(request(), NOW))).toBe(
      'PLATFORM_CHANNEL_CRAWL_DAILY_PAGE_EXCEEDED',
    );
  });

  it('同一 crawlRunId 的重试拿回同一张 Grant；绑定不符或已过期则明确拒绝', async () => {
    const { issuer, findUnique } = await fixture();
    const input = request();
    const stored = {
      requestSha256: input.requestSha256,
      technicalPolicyRevision: REVISION,
      token: 'stored.jws.token',
      expiresAt: new Date(NOW + 60_000),
    };
    findUnique.mockResolvedValueOnce(stored);
    await expect(issuer.issue(input, NOW)).resolves.toEqual({
      token: 'stored.jws.token',
      expiresAt: Math.floor((NOW + 60_000) / 1000),
    });
    findUnique.mockResolvedValueOnce({ ...stored, requestSha256: 'f'.repeat(64) });
    expect(await rejection(issuer.issue(input, NOW))).toBe('PLATFORM_GRANT_REUSE_MISMATCH');
    findUnique.mockResolvedValueOnce({ ...stored, expiresAt: new Date(NOW - 1) });
    expect(await rejection(issuer.issue(input, NOW))).toBe('PLATFORM_GRANT_REPLAY_EXPIRED');
  });

  it('任一 egress schedule 处于 DISABLED 时平台级保守拒绝', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r4-crawl-grant-'));
    dirs.push(dir);
    const binding = join(dir, 'deployment-binding.json');
    writeFileSync(binding, JSON.stringify({ validUntil: NOW + 86_400_000 }));
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const config = {
      ENGINE_BUDGET_GRANT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      ENGINE_BUDGET_GRANT_KEY_ID: 'budget-test',
      ENGINE_BUDGET_GRANT_ISSUER: 'https://127.0.0.1:18446/execution-budget',
      R4_PLATFORM_GRANT_TTL_SECONDS: 300,
      R4_DEPLOYMENT_BINDING_FILE: binding,
      R4_CHANNEL_CRAWL_GRANT_ENABLED: true,
      R4_CHANNEL_CRAWL_MAX_CAP_MICROUSD: '5000000',
      R4_CHANNEL_CRAWL_EXPECTED_TECHNICAL_POLICY_REVISION: REVISION,
    } as unknown as AppConfig;
    const prisma = {
      r4ChannelCrawlGrant: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        aggregate: vi.fn().mockResolvedValue({ _sum: { pageCap: 0n } }),
      },
    } as unknown as PrismaService;
    const policy = {
      configuredModes: () => [
        { scheduleId: 'acq-sweep', mode: 'ENABLED' },
        { scheduleId: 'intent-sweep', mode: 'DISABLED' },
        { scheduleId: 'sanctions-refresh', mode: 'ENABLED' },
      ],
    };
    const issuer = new PlatformCrawlGrantIssuer(config, prisma, policy as never);
    expect(await rejection(issuer.issue(request(), NOW))).toBe('PLATFORM_CHANNEL_CRAWL_POLICY_BLOCKED');
  });
});

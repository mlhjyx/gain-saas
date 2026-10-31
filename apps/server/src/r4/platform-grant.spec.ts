import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, decodeProtectedHeader, exportJWK, jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import { PlatformGrantIssuer, PlatformGrantRejected, type PlatformGrantRequest } from './platform-grant.service.js';

const ACTION_SHA = 'a'.repeat(64);
const ENVELOPE_SHA = 'b'.repeat(64);
const EXPECTED = JSON.stringify(Object.fromEntries(['acq-sweep','intent-sweep','sanctions-refresh','patents-cache-refresh'].map((s) => [s, { requestSha256: ACTION_SHA, envelopeSha256: ENVELOPE_SHA }])));
const NOW = 1_793_500_000_000;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function fixture(overrides: Partial<AppConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'r4-platform-grant-'));
  dirs.push(dir);
  const binding = join(dir, 'deployment-binding.json');
  writeFileSync(
    binding,
    JSON.stringify({
      validUntil: NOW + 86_400_000,
      scheduleActions: [
        { scheduleId: 'acq-sweep', actionSha256: ACTION_SHA },
        { scheduleId: 'intent-sweep', actionSha256: ACTION_SHA },
        { scheduleId: 'sanctions-refresh', actionSha256: ACTION_SHA },
        { scheduleId: 'patents-cache-refresh', actionSha256: ACTION_SHA },
      ],
    }),
  );
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const jwk = await exportJWK(createPublicKey(pem));
  const config = {
    ENGINE_BUDGET_GRANT_PRIVATE_KEY: pem,
    ENGINE_BUDGET_GRANT_KEY_ID: 'budget-test',
    ENGINE_BUDGET_GRANT_ISSUER: 'https://127.0.0.1:18446/execution-budget',
    R4_PLATFORM_GRANT_MAX_CAP_MICROUSD: '{"acq-sweep":"1","patents-cache-refresh":"1","intent-sweep":"10000000","sanctions-refresh":"1"}',
    R4_PLATFORM_GRANT_TTL_SECONDS: 300,
    R4_PLATFORM_GRANT_EXPECTED: EXPECTED,
    R4_PLATFORM_GRANT_CLIENT_SUBJECT: 'global-backend-platform-worker',
    R4_DEPLOYMENT_BINDING_FILE: binding,
    ...overrides,
  } as unknown as AppConfig;
  const findUnique = vi.fn().mockResolvedValue(null);
  const create = vi.fn().mockResolvedValue({});
  const prisma = { r4PlatformGrant: { findUnique, create } } as unknown as PrismaService;
  return { issuer: new PlatformGrantIssuer(config, prisma), config, binding, pkJwks: { keys: [{ ...jwk, kid: 'budget-test', alg: 'RS256', use: 'sig' }] }, findUnique, create };
}

const request = (overrides: Partial<PlatformGrantRequest> = {}): PlatformGrantRequest => ({
  scheduleId: 'acq-sweep',
  purpose: 'platform.acquisition',
  workflowId: 'acq-sweep-workflow',
  workflowRunId: randomUUID(),
  scheduleRequestSha256: ACTION_SHA,
  technicalPolicyRevision: ENVELOPE_SHA,
  capPerRunMicrousd: '1',
  campaignCapMicrousd: '1',
  ...overrides,
});

describe('平台运行 Grant 签发', () => {
  it('部署绑定显式撤销后拒绝签发新 Grant', async () => {
    const { issuer, binding } = await fixture();
    const parsed = JSON.parse(readFileSync(binding, 'utf8')) as Record<string, unknown>;
    writeFileSync(binding, JSON.stringify({ ...parsed, revokedAt: new Date(NOW).toISOString() }));
    await expect(issuer.issue(request(), NOW)).rejects.toMatchObject({
      code: 'PLATFORM_GRANT_BINDING_REVOKED',
    });
  });

  it('header 与 21 个 claims 与引擎校验器逐字一致', async () => {
    const { issuer, pkJwks } = await fixture();
    const { token, expiresAt } = await issuer.issue(request(), NOW);
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'RS256', kid: 'budget-test', typ: 'execution-budget-grant+jwt' });
    const { payload } = await jwtVerify(token, createLocalJWKSet(pkJwks), {
      issuer: 'https://127.0.0.1:18446/execution-budget',
      audience: 'global-backend:execution-budget',
      currentDate: new Date(NOW + 1_000),
    });
    expect(Object.keys(payload).sort()).toEqual([
      'aud', 'authority_kind', 'campaign_cap_microusd', 'cap_per_run_microusd', 'currency',
      'exp', 'iat', 'iss', 'jti', 'max_runs', 'nbf', 'purpose', 'schedule_id',
      'schedule_request_sha256', 'schema_version', 'subject_id', 'subject_type',
      'technical_policy_revision', 'unit', 'workflow_id', 'workflow_run_id',
    ]);
    expect(payload.authority_kind).toBe('PLATFORM_GRANT');
    expect(payload.schema_version).toBe('execution-budget-grant/v1');
    expect(payload.subject_type).toBe('schedule');
    expect(payload.subject_id).toBe('acq-sweep');
    expect(payload.max_runs).toBe('1');
    expect(payload.cap_per_run_microusd).toBe('1');
    expect(payload.campaign_cap_microusd).toBe('1');
    expect(payload.exp! - payload.iat!).toBe(300);
    expect(expiresAt).toBe(Math.floor(NOW / 1000) + 300);
  });

  it('拒绝未知 schedule / purpose 不匹配 / 策略副本不一致 / 超上限 / campaign≠cap', async () => {
    const { issuer } = await fixture();
    await expect(issuer.issue(request({ scheduleId: 'nope' }), NOW)).rejects.toMatchObject({ code: 'PLATFORM_GRANT_SCHEDULE_UNKNOWN' });
    await expect(issuer.issue(request({ purpose: 'platform.sanctions' }), NOW)).rejects.toMatchObject({ code: 'PLATFORM_GRANT_PURPOSE_MISMATCH' });
    await expect(issuer.issue(request({ scheduleRequestSha256: 'c'.repeat(64) }), NOW)).rejects.toMatchObject({ code: 'PLATFORM_GRANT_REQUEST_MISMATCH' });
    await expect(issuer.issue(request({ technicalPolicyRevision: 'c'.repeat(64) }), NOW)).rejects.toMatchObject({ code: 'PLATFORM_GRANT_REQUEST_MISMATCH' });
    await expect(issuer.issue(request({ capPerRunMicrousd: '2', campaignCapMicrousd: '2' }), NOW)).rejects.toMatchObject({ code: 'PLATFORM_GRANT_CAP_EXCEEDED' });
    await expect(issuer.issue(request({ campaignCapMicrousd: '2' }), NOW)).rejects.toMatchObject({ code: 'PLATFORM_GRANT_REQUEST_INVALID' });
  });

  it('部署绑定缺失 / 无效 / 过期时拒绝', async () => {
    const missing = await fixture({ R4_DEPLOYMENT_BINDING_FILE: undefined } as unknown as Partial<AppConfig>);
    await expect(missing.issuer.issue(request(), NOW)).rejects.toMatchObject({ code: 'PLATFORM_GRANT_BINDING_UNAVAILABLE' });
    const invalid = await fixture();
    writeFileSync(invalid.config.R4_DEPLOYMENT_BINDING_FILE!, '{}');
    await expect(invalid.issuer.issue(request(), NOW)).rejects.toMatchObject({ code: 'PLATFORM_GRANT_BINDING_UNAVAILABLE' });
    const expired = await fixture();
    writeFileSync(expired.config.R4_DEPLOYMENT_BINDING_FILE!, JSON.stringify({ validUntil: NOW - 1, scheduleActions: [{ scheduleId: 'acq-sweep', actionSha256: ACTION_SHA }] }));
    await expect(expired.issuer.issue(request(), NOW)).rejects.toMatchObject({ code: 'PLATFORM_GRANT_BINDING_UNAVAILABLE' });
  });

  it('同一 run 幂等返回已签发的 JWS；绑定不一致或过期则拒绝', async () => {
    const { issuer, findUnique } = await fixture();
    const req = request();
    const first = await issuer.issue(req, NOW);
    findUnique.mockResolvedValue({
      workflowRunId: req.workflowRunId,
      scheduleRequestSha256: req.scheduleRequestSha256,
      technicalPolicyRevision: req.technicalPolicyRevision,
      token: first.token,
      expiresAt: new Date(first.expiresAt * 1000),
    });
    await expect(issuer.issue(req, NOW + 1_000)).resolves.toMatchObject({ token: first.token });
    findUnique.mockResolvedValue({
      workflowRunId: req.workflowRunId,
      scheduleRequestSha256: req.scheduleRequestSha256,
      technicalPolicyRevision: 'd'.repeat(64),
      token: first.token,
      expiresAt: new Date(first.expiresAt * 1000),
    });
    await expect(issuer.issue(req, NOW + 1_000)).rejects.toMatchObject({ code: 'PLATFORM_GRANT_REUSE_MISMATCH' });
    findUnique.mockResolvedValue({
      workflowRunId: req.workflowRunId,
      scheduleRequestSha256: req.scheduleRequestSha256,
      technicalPolicyRevision: req.technicalPolicyRevision,
      token: first.token,
      expiresAt: new Date(first.expiresAt * 1000),
    });
    await expect(issuer.issue(req, first.expiresAt * 1000)).rejects.toMatchObject({ code: 'PLATFORM_GRANT_REPLAY_EXPIRED' });
  });

  it('并发插入冲突（P2002）时返回赢家签发的那张', async () => {
    const { issuer, findUnique, create } = await fixture();
    const req = request();
    const winner = 'winner.jws.token';
    create.mockRejectedValueOnce({ code: 'P2002' });
    findUnique.mockResolvedValue({
      workflowRunId: req.workflowRunId,
      scheduleRequestSha256: req.scheduleRequestSha256,
      technicalPolicyRevision: req.technicalPolicyRevision,
      token: winner,
      expiresAt: new Date((Math.floor(NOW / 1000) + 200) * 1000),
    });
    await expect(issuer.issue(req, NOW)).resolves.toMatchObject({ token: winner });
  });
});

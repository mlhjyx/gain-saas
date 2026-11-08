import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { EngineBudgetGrantService } from '../bff/engine-budget-grant.service.js';
import { CampaignPlanEngineClient } from './campaign-plan-engine.client.js';
import type { CampaignTenant } from './campaign.service.js';

/**
 * BFF → 引擎触发（M2.1）：quote 请求必须是引擎 `POST /campaigns/:campaignId/plan-drafts`
 * 的精确形状（含 jobId，否则 Grant SCOPE_MISMATCH）；服务身份头与一次性 Grant 同时携带；
 * 失败分类（停用/未配置/冲突/不可达）稳定。
 */

const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAMPAIGN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const tenant: CampaignTenant = { userId: 'user-1', workspaceId: WORKSPACE, role: 'admin' };

function buildClient(overrides: Partial<AppConfig> = {}) {
  const budget = {
    issue: vi.fn(async () => 'compact.grant.jws'),
  } as unknown as EngineBudgetGrantService;
  const config = {
    ENGINE_ORIGIN: 'http://127.0.0.1:3000',
    CAMPAIGN_PLAN_JOB_ENABLED: true,
    CAMPAIGN_PLAN_ENGINE_SERVICE_TOKEN: 'service-token',
    ...overrides,
  } as AppConfig;
  return { client: new CampaignPlanEngineClient(config, budget), budget };
}

const input = {
  workspaceId: WORKSPACE,
  campaignId: CAMPAIGN,
  jobId: JOB,
  objective: '在德国找 30 家泵类分销商',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CampaignPlanEngineClient.trigger', () => {
  it('quotes with the exact engine operation shape and posts the draft with service identity', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { jobId: JOB } }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const { client, budget } = buildClient();

    await client.trigger(tenant, { ...input, audienceSizeCap: 500 });

    expect(budget.issue).toHaveBeenCalledWith(tenant, {
      operation: 'POST /campaigns/:campaignId/plan-drafts',
      campaignId: CAMPAIGN,
      body: { jobId: JOB },
    });
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://127.0.0.1:3000/api/v1/internal/campaign-plans/draft');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-service-token']).toBe('service-token');
    expect((init.headers as Record<string, string>)['X-Execution-Budget-Grant']).toBe(
      'compact.grant.jws',
    );
    expect(JSON.parse(String(init.body))).toEqual({
      workspaceId: WORKSPACE,
      campaignId: CAMPAIGN,
      jobId: JOB,
      objective: input.objective,
      audienceSizeCap: 500,
    });
  });

  it('fails closed with 503 when the rollback switch is off or the token is missing', async () => {
    const off = buildClient({ CAMPAIGN_PLAN_JOB_ENABLED: false }).client;
    await expect(off.trigger(tenant, input)).rejects.toMatchObject({
      response: { error: { code: 'CAMPAIGN_PLAN_JOB_DISABLED' } },
    });
    const missing = buildClient({ CAMPAIGN_PLAN_ENGINE_SERVICE_TOKEN: undefined }).client;
    await expect(missing.trigger(tenant, input)).rejects.toMatchObject({
      response: { error: { code: 'CAMPAIGN_PLAN_ENGINE_NOT_CONFIGURED' } },
    });
  });

  it('maps an engine 409 to a stable conflict', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: 'EXECUTION_BUDGET_GRANT_REUSED' } }), {
          status: 409,
        }),
      ),
    );
    const { client } = buildClient();
    await expect(client.trigger(tenant, input)).rejects.toMatchObject({
      response: { error: { code: 'CAMPAIGN_PLAN_ENGINE_CONFLICT' } },
    });
  });

  it('maps network failures to 502 CAMPAIGN_PLAN_ENGINE_UNAVAILABLE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const { client } = buildClient();
    await expect(client.trigger(tenant, input)).rejects.toMatchObject({
      response: { error: { code: 'CAMPAIGN_PLAN_ENGINE_UNAVAILABLE' } },
    });
  });
});

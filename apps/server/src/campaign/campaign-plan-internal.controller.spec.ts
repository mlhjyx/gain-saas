import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { AppConfig } from '../config/configuration.js';
import { CampaignServiceTokenGuard } from './campaign-internal.controller.js';
import { CampaignPlanInternalController } from './campaign-plan-internal.controller.js';
import type { CampaignPlanJobService } from './campaign-plan-job.service.js';

/**
 * M2.1 内部回调入口：服务令牌 fail-closed（负向 2：缺失/错误 → 401，未配置 → 503），
 * 以及控制器只做委托（幂等/状态语义在 job service 与其 spec 里）。
 */

function context(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

function guardWith(token: string | undefined) {
  return new CampaignServiceTokenGuard({ CAMPAIGN_INTERNAL_SERVICE_TOKEN: token } as AppConfig);
}

describe('CampaignServiceTokenGuard (M2.1 回调)', () => {
  it('fails closed with 503 when the service token is not configured', () => {
    expect(() => guardWith(undefined).canActivate(context({ 'x-service-token': 'x' }))).toThrow(
      ServiceUnavailableException,
    );
  });

  it('rejects missing and mismatched tokens with 401', () => {
    const guard = guardWith('expected-token-value');
    expect(() => guard.canActivate(context({}))).toThrow(UnauthorizedException);
    expect(() =>
      guard.canActivate(context({ 'x-service-token': 'wrong-token-value' })),
    ).toThrow(UnauthorizedException);
    expect(() =>
      guard.canActivate(context({ 'x-service-token': 'expected-token-value' })),
    ).not.toThrow();
  });
});

describe('CampaignPlanInternalController', () => {
  it('delegates revision delivery and job failure reports to the job service', async () => {
    const jobs = {
      completePlanJob: vi.fn(async () => ({
        revisionId: 'r',
        revisionNo: 1,
        planHash: 'a'.repeat(64),
        state: 'DRAFT',
        idempotent: false,
      })),
      reportJobFailure: vi.fn(async () => ({ id: 'job', state: 'FAILED' })),
    } as unknown as CampaignPlanJobService;
    const controller = new CampaignPlanInternalController(jobs);

    await expect(
      controller.completeRevision({ jobId: 'job', workspaceId: 'w', campaignId: 'c', plan: {} }),
    ).resolves.toEqual({
      data: {
        revisionId: 'r',
        revisionNo: 1,
        planHash: 'a'.repeat(64),
        state: 'DRAFT',
        idempotent: false,
      },
    });
    await expect(
      controller.reportFailure('job', {
        workspaceId: 'w',
        state: 'FAILED',
        error: 'SKILL_PLATFORM_DISABLED',
      }),
    ).resolves.toEqual({ data: { id: 'job', state: 'FAILED' } });
    expect(jobs.completePlanJob).toHaveBeenCalledTimes(1);
    expect(jobs.reportJobFailure).toHaveBeenCalledWith('job', expect.anything());
  });
});

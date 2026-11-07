import { BadRequestException, HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { EngineHttp } from '../bff/engine-http.js';
import { ClaimDraftsController } from './claim-drafts.controller.js';
import type { TenantRequestContext } from './tenant.guard.js';

const COMPANY_ID = '55555555-5555-4555-8555-555555555555';

function tenant(): TenantRequestContext {
  return {
    userId: 'u-1',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    role: 'admin',
    jti: 'j-1',
    exp: 0,
    onboardingCompleted: true,
    onboardingCompanyId: COMPANY_ID,
  };
}

function fixture(engineResult: { status: number; body: unknown } | Error) {
  const engine = new EngineHttp({} as never, {} as never);
  const call = vi.fn(async () => {
    if (engineResult instanceof Error) throw engineResult;
    return { ...engineResult, contentType: 'application/json', headers: {} };
  });
  (engine as unknown as { call: Mock }).call = call;
  const controller = new ClaimDraftsController(engine);
  const req = { tenant: tenant() } as unknown as Request;
  return { controller, req, call };
}

describe('ClaimDraftsController（P5：档案事实草稿代理，/api/onboarding 前缀）', () => {
  it('成功时透传引擎 data（created/skipped/claims）', async () => {
    const { controller, req, call } = fixture({
      status: 200,
      body: { data: { created: 2, skipped: 1, claims: [{ id: 'c1' }, { id: 'c2' }] } },
    });
    const result = await controller.synthesize(req, COMPANY_ID);
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-1' }), 'POST', `/companies/${COMPANY_ID}/claim-drafts`);
    expect(result).toEqual({ data: { created: 2, skipped: 1, claims: expect.any(Array) } });
  });

  it('companyId 非 UUID → 400，不调引擎', async () => {
    const { controller, req, call } = fixture({ status: 200, body: {} });
    await expect(controller.synthesize(req, 'not-a-uuid')).rejects.toBeInstanceOf(BadRequestException);
    expect(call).not.toHaveBeenCalled();
  });

  it('引擎 404 → HttpException 404，错误体带三层文案（跨租户不泄露存在性）', async () => {
    const { controller, req } = fixture({
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'company not found' } },
    });
    try {
      await controller.synthesize(req, COMPANY_ID);
      expect.unreachable('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const http = err as HttpException;
      expect(http.getStatus()).toBe(404);
      const body = http.getResponse() as { error: { code: string; userCopy?: { title: string } } };
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.userCopy?.title).toBeTruthy();
    }
  });

  it('引擎不可达 → 502 MODEL_UPSTREAM_UNUSABLE（userCopy 由全局过滤器统一补）', async () => {
    const { controller, req } = fixture(new Error('ECONNREFUSED'));
    try {
      await controller.synthesize(req, COMPANY_ID);
      expect.unreachable('应当抛错');
    } catch (err) {
      const http = err as HttpException;
      expect(http.getStatus()).toBe(502);
      const body = http.getResponse() as { error: { code: string } };
      expect(body.error.code).toBe('MODEL_UPSTREAM_UNUSABLE');
    }
  });
});

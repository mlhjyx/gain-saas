import { BadRequestException, HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { EngineHttp } from '../bff/engine-http.js';
import { RunTraceController } from './run-trace.controller.js';
import type { TenantRequestContext } from './tenant.guard.js';

const RUN_ID = '66666666-6666-4666-8666-666666666666';

function tenant(): TenantRequestContext {
  return {
    userId: 'u-1',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    role: 'member',
    jti: 'j-1',
    exp: 0,
    onboardingCompleted: true,
    onboardingCompanyId: null,
  };
}

function fixture(engineResult: { status: number; body: unknown } | Error) {
  const engine = new EngineHttp({} as never, {} as never);
  const call = vi.fn(async () => {
    if (engineResult instanceof Error) throw engineResult;
    return { ...engineResult, contentType: 'application/json', headers: {} };
  });
  (engine as unknown as { call: Mock }).call = call;
  const controller = new RunTraceController(engine);
  const req = { tenant: tenant() } as unknown as Request;
  return { controller, req, call };
}

describe('RunTraceController（M2 步 9b-4：过程时间线代理，/api/runs 前缀）', () => {
  it('成功时把引擎 { data, page } 原样包回 data（前端解出 { data, page }）', async () => {
    const engineBody = {
      data: [
        { id: 't1', decisionType: 'source.route', chosenOption: { sources: ['wikidata'] } },
      ],
      page: { next_cursor: null, has_more: false },
    };
    const { controller, req, call } = fixture({ status: 200, body: engineBody });
    const result = await controller.trace(req, RUN_ID, '50', undefined);
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-1' }),
      'GET',
      `/runs/${RUN_ID}/trace`,
      { query: { limit: '50' } },
    );
    expect(result).toEqual({ data: engineBody });
  });

  it('透传 cursor 查询参数', async () => {
    const { controller, req, call } = fixture({
      status: 200,
      body: { data: [], page: { next_cursor: null, has_more: false } },
    });
    await controller.trace(req, RUN_ID, undefined, 'abc');
    expect(call).toHaveBeenCalledWith(expect.anything(), 'GET', `/runs/${RUN_ID}/trace`, {
      query: { cursor: 'abc' },
    });
  });

  it('runId 非 UUID → 400，不调引擎', async () => {
    const { controller, req, call } = fixture({ status: 200, body: {} });
    await expect(controller.trace(req, 'not-a-uuid')).rejects.toBeInstanceOf(BadRequestException);
    expect(call).not.toHaveBeenCalled();
  });

  it('引擎 404 → HttpException 404，错误体带三层文案（跨租户不泄露存在性）', async () => {
    const { controller, req } = fixture({
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'run not found' } },
    });
    try {
      await controller.trace(req, RUN_ID);
      expect.unreachable('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(404);
      const body = (err as HttpException).getResponse() as {
        error?: { userCopy?: { title?: string } };
      };
      expect(body.error?.userCopy?.title).toBeTruthy();
    }
  });

  it('引擎不可达 → 502', async () => {
    const { controller, req } = fixture(new Error('ECONNREFUSED'));
    try {
      await controller.trace(req, RUN_ID);
      expect.unreachable('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(502);
    }
  });
});

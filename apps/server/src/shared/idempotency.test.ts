import { describe, expect, it, vi } from 'vitest';
import { lastValueFrom, of } from 'rxjs';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { IDEMPOTENCY_KEY_PATTERN, IdempotencyService } from './idempotency.service.js';

const KEY = 'post-accept-0001';

function fakeService(initial: Record<string, unknown> | null = null) {
  const state: { row: Record<string, unknown> | null } = { row: initial };
  return {
    requestHash: (body: unknown) =>
      JSON.stringify(body ?? null), // 测试里用可读等价物
    lookup: vi.fn(async () => state.row),
    save: vi.fn(async (input: Record<string, unknown>) => {
      if (state.row) return state.row;
      state.row = {
        requestHash: input.requestHash,
        responseStatus: input.responseStatus,
        responseBody: input.body,
        expiresAt: new Date(Date.now() + 1000),
      };
      return state.row;
    }),
    state,
  };
}

function context(options: {
  body?: unknown;
  key?: string;
  method?: string;
  tenant?: { workspaceId: string } | null;
}) {
  const req = {
    method: options.method ?? 'POST',
    headers: options.key ? { 'idempotency-key': options.key } : {},
    body: options.body ?? { verdict: 'accept' },
    baseUrl: '/api/v1',
    path: '/acquisition-tasks/t-1/accept',
    route: { path: '/acquisition-tasks/:id/accept' },
    originalUrl: '/api/v1/acquisition-tasks/t-1/accept',
    tenant: options.tenant === undefined ? { workspaceId: 'ws-1' } : options.tenant,
  };
  const res = { statusCode: 201, status: vi.fn() };
  const http = { getRequest: () => req, getResponse: () => res };
  const ctx = { switchToHttp: () => http } as unknown as ExecutionContext;
  return { ctx, req, res };
}

function handler(data: unknown): CallHandler {
  return { handle: () => of(data) };
}

describe('IdempotencyKey（P5b-05）', () => {
  it('键格式：8–128 位字母数字与 ._:‑', () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test(KEY)).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test('short')).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test('bad key with space')).toBe(false);
  });

  it('未带键或非租户请求直接放行，不查库', async () => {
    const service = fakeService();
    const interceptor = new IdempotencyInterceptor(service as never);
    const { ctx } = context({ key: undefined });
    await lastValueFrom(interceptor.intercept(ctx, handler({ ok: 1 })));
    expect(service.lookup).not.toHaveBeenCalled();

    const noTenant = context({ key: KEY, tenant: null });
    await lastValueFrom(
      new IdempotencyInterceptor(service as never).intercept(
        noTenant.ctx,
        handler({ ok: 2 }),
      ),
    );
    expect(service.lookup).not.toHaveBeenCalled();
  });

  it('首次请求执行并存响应；重放不执行第二次、返回同一响应与状态码', async () => {
    const service = fakeService();
    const interceptor = new IdempotencyInterceptor(service as never);
    const first = context({ key: KEY });
    const executed = vi.fn(() => of({ data: { accepted: true } }));
    const out1 = await lastValueFrom(
      interceptor.intercept(first.ctx, { handle: executed } as CallHandler),
    );
    expect(executed).toHaveBeenCalledTimes(1);
    expect(out1).toEqual({ data: { accepted: true } });
    expect(service.save).toHaveBeenCalledTimes(1);

    const replay = context({ key: KEY });
    const executed2 = vi.fn(() => of({ data: { accepted: true } }));
    const out2 = await lastValueFrom(
      interceptor.intercept(replay.ctx, { handle: executed2 } as CallHandler),
    );
    expect(executed2).not.toHaveBeenCalled();
    expect(out2).toEqual({ data: { accepted: true } });
  });

  it('同键不同请求体 → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const service = fakeService({
      requestHash: JSON.stringify({ verdict: 'accept' }),
      responseStatus: 201,
      responseBody: { data: { accepted: true } },
      expiresAt: new Date(Date.now() + 1000),
    });
    const interceptor = new IdempotencyInterceptor(service as never);
    const { ctx } = context({ key: KEY, body: { verdict: 'reject' } });
    await expect(
      lastValueFrom(interceptor.intercept(ctx, handler({ ok: true }))),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('非法键 → 400 IDEMPOTENCY_KEY_INVALID', () => {
    const service = fakeService();
    const interceptor = new IdempotencyInterceptor(service as never);
    const { ctx } = context({ key: 'x' });
    // 同步抛错由 Nest 统一转为 400（拦截器在进入 handler 前 fail-closed）。
    expect(() => interceptor.intercept(ctx, handler({ ok: true }))).toThrow(
      BadRequestException,
    );
  });

  it('requestHash 对相同体稳定、对不同体不同（真实服务逻辑）', () => {
    const service = new IdempotencyService({} as never);
    expect(service.requestHash({ a: 1 })).toBe(service.requestHash({ a: 1 }));
    expect(service.requestHash({ a: 1 })).not.toBe(service.requestHash({ a: 2 }));
    expect(service.requestHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

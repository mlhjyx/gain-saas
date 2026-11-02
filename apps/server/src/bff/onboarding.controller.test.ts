import { BadRequestException, ConflictException, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { BffGuard } from './bff.module.js';
import { EngineHttp } from './engine-http.js';
import { OnboardingController } from './onboarding.controller.js';
import type { TenantRequestContext } from '../tenant/tenant.guard.js';

function tenant(overrides: Partial<TenantRequestContext> = {}): TenantRequestContext {
  return {
    userId: 'u-1',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    role: 'admin',
    jti: 'j-1',
    exp: 0,
    onboardingCompleted: false,
    onboardingCompanyId: null,
    ...overrides,
  };
}

function fixture(options: {
  tenant?: Partial<TenantRequestContext>;
  engineResult?: { status: number; body: unknown };
} = {}) {
  const engine = new EngineHttp({} as never, {} as never);
  const call = vi.fn(async () => options.engineResult ?? { status: 201, body: { data: { id: 'engine-company-1' } } });
  (engine as unknown as { call: Mock }).call = call;
  const update = vi.fn(async () => ({}));
  const auditRecord = vi.fn(async () => undefined);
  const issue = vi.fn(async () => 'grant.jws.sig');
  const controller = new OnboardingController(
    { workspace: { update } } as never,
    { record: auditRecord } as never,
    engine,
    { issue } as never,
  );
  const req = { tenant: tenant(options.tenant) } as unknown as Request;
  const res = { status: vi.fn() } as unknown as Response;
  return { controller, req, res, engine, call, update, auditRecord, issue };
}

describe('OnboardingController（SD11 注册引导建档）', () => {
  it('未知字段与缺 name/website 一律 400，不签发 Grant', async () => {
    const { controller, req, res, issue } = fixture();
    await expect(
      controller.createCompany(req, res, { name: 'Acme', evil: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.createCompany(req, res, { industry: 'isic-2813' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(issue).not.toHaveBeenCalled();
  });

  it('targetMarkets/products/businessEmail 校验与引擎同构', async () => {
    const { controller, req, res, issue } = fixture();
    await expect(
      controller.createCompany(req, res, { name: 'Acme', targetMarkets: ['de'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.createCompany(req, res, { name: 'Acme', products: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.createCompany(req, res, { name: 'Acme', businessEmail: 'not-an-email' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(issue).not.toHaveBeenCalled();
  });

  it('非管理员不能完成建档', async () => {
    const { controller, req, res, issue } = fixture({ tenant: { role: 'member' } });
    const error = await controller
      .createCompany(req, res, { name: 'Acme' })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(403);
    expect(issue).not.toHaveBeenCalled();
  });

  it('已完成引导的工作空间返回 409', async () => {
    const { controller, req, res } = fixture({ tenant: { onboardingCompleted: true } });
    await expect(
      controller.createCompany(req, res, { name: 'Acme' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('成功路径：签发 Grant → 引擎建档 → 落 onboarding 标记与审计', async () => {
    const { controller, req, res, call, update, auditRecord, issue } = fixture();
    const body = {
      name: '具安科技',
      industry: 'isic-2813',
      targetMarkets: ['DE', 'US'],
      products: ['精密轴承'],
      businessEmail: 'sales@example.test',
    };
    const result = await controller.createCompany(req, res, body, 'idem-1');

    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-1', workspaceId: req.tenant!.workspaceId }),
      { operation: 'POST /companies', body },
    );
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-1' }),
      'POST',
      '/companies',
      expect.objectContaining({
        body,
        headers: expect.objectContaining({
          'x-execution-budget-grant': 'grant.jws.sig',
          'idempotency-key': 'idem-1',
        }),
      }),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: req.tenant!.workspaceId },
      data: {
        onboardingCompletedAt: expect.any(Date),
        onboardingCompanyId: 'engine-company-1',
      },
    });
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'onboarding.complete', detail: { companyId: 'engine-company-1' } }),
    );
    expect((res.status as Mock)).toHaveBeenCalledWith(201);
    expect(result).toEqual({ data: { id: 'engine-company-1' } });
  });

  it('引擎业务错误原样映射（示例：409 SUPPRESSED），不落 onboarding 标记', async () => {
    const { controller, req, res, update } = fixture({
      engineResult: { status: 409, body: { error: { code: 'SUPPRESSED', message: 'blocked' } } },
    });
    const result = await controller.createCompany(req, res, { name: 'Acme' });
    expect((res.status as Mock)).toHaveBeenCalledWith(409);
    expect((result as { error: { code: string } }).error.code).toBe('SUPPRESSED');
    expect(update).not.toHaveBeenCalled();
  });
});

describe('BffGuard：未完成引导拒绝业务请求（SD11）', () => {
  function guardCtx(req: Request) {
    return {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as Parameters<BffGuard['canActivate']>[0];
  }

  it('onboardingCompleted=false 时以 409 ONBOARDING_INCOMPLETE 拒绝 BFF 业务路由', async () => {
    const req = {
      method: 'GET',
      path: '/api/companies',
      tenant: tenant(),
    } as unknown as Request;
    const guard = new BffGuard({ canActivate: async () => true } as never, {} as never);
    const error = await guard
      .canActivate(guardCtx(req))
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(409);
    expect((error as HttpException).getResponse()).toMatchObject({
      error: { code: 'ONBOARDING_INCOMPLETE' },
    });
  });

  it('已完成引导时放行 member 路由', async () => {
    const req = {
      method: 'GET',
      path: '/api/companies',
      tenant: tenant({ onboardingCompleted: true }),
    } as unknown as Request;
    const guard = new BffGuard({ canActivate: async () => true } as never, {} as never);
    await expect(guard.canActivate(guardCtx(req))).resolves.toBe(true);
  });
});

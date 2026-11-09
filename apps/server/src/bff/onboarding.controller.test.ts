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
  engineImpl?: (method: string, path: string) => { status: number; body: unknown };
} = {}) {
  const engine = new EngineHttp({} as never, {} as never);
  const call = vi.fn(async (
    _tenant: unknown,
    method: string,
    path: string,
  ) => options.engineImpl?.(method, path) ?? options.engineResult ?? { status: 201, body: { data: { id: 'engine-company-1' } } });
  (engine as unknown as { call: Mock }).call = call;
  const update = vi.fn(async () => ({}));
  const auditRecord = vi.fn(async () => undefined);
  const issue = vi.fn(
    async (_tenant: unknown, _quote: Record<string, unknown>) => 'grant.jws.sig',
  );
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

/** 引擎理解预览响应（与引擎 GET /companies/:id/understanding-preview 同形）。 */
const PREVIEW = {
  companyId: 'engine-company-1',
  name: '具安科技',
  website: 'https://acme.test',
  status: 'REVIEW',
  state: 'ready',
  failure: null,
  pagesAnalyzed: 4,
  industry: {
    raw: '精密机械制造',
    suggested: {
      raw: '精密机械制造',
      code: '28',
      label: '通用及专用设备制造',
      labelEn: 'Manufacture of machinery',
      matched: true,
    },
    options: [
      { code: '28', label: '通用及专用设备制造', labelEn: 'Manufacture of machinery', nace: ['28'] },
    ],
  },
  products: [
    {
      name: 'CNC 精密加工件',
      source: 'understanding',
      sourceUrl: 'https://acme.test/products',
      evidence: 'CNC parts',
    },
  ],
  markets: [
    { code: 'DE', name: '德国', evidence: 'export to Germany', sourceUrl: 'https://acme.test/about' },
  ],
  updatedAt: '2026-11-10T08:00:00Z',
};

describe('OnboardingController（注册即建档第 1 步：理解预览 + 反向填充）', () => {
  it('POST preview：先建草稿档案（不改 completedAt），再返回理解预览', async () => {
    const { controller, req, issue, update, auditRecord, call } = fixture({
      engineImpl: (method, path) => {
        if (method === 'POST' && path === '/companies') {
          return { status: 201, body: { data: { id: 'engine-company-1', status: 'DRAFT' } } };
        }
        if (method === 'GET' && path === '/companies/engine-company-1/understanding-preview') {
          return { status: 200, body: { data: PREVIEW } };
        }
        return { status: 404, body: { error: { code: 'NOT_FOUND' } } };
      },
    });
    const result = await controller.startPreview(req, { website: 'https://acme.test', name: '具安科技' });
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: req.tenant!.workspaceId }),
      { operation: 'POST /companies', body: { website: 'https://acme.test', name: '具安科技' } },
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: req.tenant!.workspaceId },
      data: { onboardingCompanyId: 'engine-company-1' },
    });
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-1' }),
      'POST',
      '/companies',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-execution-budget-grant': 'grant.jws.sig',
          'idempotency-key': expect.stringMatching(/^onboarding-preview:[0-9a-f]{64}$/),
        }),
      }),
    );
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'onboarding.preview_started',
        detail: { companyId: 'engine-company-1', kind: 'website' },
      }),
    );
    expect(result).toMatchObject({ data: { started: true, preview: { state: 'ready' } } });
  });

  it('POST preview：失败过的草稿用新的 attemptId 重试理解', async () => {
    const { controller, req, issue, call } = fixture({
      tenant: { onboardingCompanyId: 'engine-company-1' },
      engineImpl: (method, path) => {
        if (method === 'GET' && path === '/companies/engine-company-1') {
          return {
            status: 200,
            body: {
              data: {
                id: 'engine-company-1',
                name: '具安科技',
                website: 'https://acme.test',
                status: 'DRAFT',
                understandingFailedAt: '2026-11-10T07:00:00Z',
              },
            },
          };
        }
        if (method === 'POST' && path === '/companies/engine-company-1/understanding/retry') {
          return { status: 202, body: { data: { id: 'engine-company-1', status: 'DRAFT' } } };
        }
        if (method === 'GET' && path === '/companies/engine-company-1/understanding-preview') {
          return { status: 200, body: { data: { ...PREVIEW, state: 'queued', status: 'DRAFT' } } };
        }
        return { status: 404, body: { error: { code: 'NOT_FOUND' } } };
      },
    });
    await controller.startPreview(req, { website: 'https://acme.test' });
    const retryQuote = issue.mock.calls[0]![1] as Record<string, unknown>;
    expect(retryQuote.operation).toBe('POST /companies/:companyId/understanding/retry');
    expect(retryQuote.companyId).toBe('engine-company-1');
    expect((retryQuote.body as { attemptId: string }).attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-1' }),
      'POST',
      '/companies/engine-company-1/understanding/retry',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-execution-budget-grant': 'grant.jws.sig' }),
      }),
    );
  });

  it('GET preview：未开始时返回 started=false', async () => {
    const { controller, req } = fixture();
    await expect(controller.preview(req)).resolves.toEqual({ data: { started: false } });
  });

  it('完成建档：勾选事实写回同一档案，审计记录建议 vs 选择', async () => {
    const { controller, req, res, update, auditRecord, call } = fixture({
      tenant: { onboardingCompanyId: 'engine-company-1' },
      engineImpl: (method, path) => {
        if (method === 'GET' && path === '/companies/engine-company-1') {
          return { status: 200, body: { data: { id: 'engine-company-1', status: 'REVIEW' } } };
        }
        if (method === 'GET' && path === '/companies/engine-company-1/understanding-preview') {
          return { status: 200, body: { data: PREVIEW } };
        }
        if (method === 'POST' && path === '/companies/engine-company-1/onboarding-facts') {
          return { status: 200, body: { data: { id: 'engine-company-1', industryCode: '28' } } };
        }
        return { status: 404, body: { error: { code: 'NOT_FOUND' } } };
      },
    });
    const body = {
      name: '具安科技',
      industry: '通用及专用设备制造',
      industryCode: '28',
      targetMarkets: ['DE', 'FR'],
      products: ['CNC 精密加工件', '钣金件'],
      businessEmail: 'sales@acme.test',
    };
    const result = await controller.createCompany(req, res, body);
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-1' }),
      'POST',
      '/companies/engine-company-1/onboarding-facts',
      expect.objectContaining({ body }),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: req.tenant!.workspaceId },
      data: { onboardingCompletedAt: expect.any(Date), onboardingCompanyId: 'engine-company-1' },
    });
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'onboarding.complete',
        detail: expect.objectContaining({
          companyId: 'engine-company-1',
          understandingState: 'ready',
          pagesAnalyzed: 4,
          industrySuggested: '28',
          industryChosen: '28',
          industryAccepted: true,
          productsSuggested: 1,
          productsChosen: 2,
          productsAccepted: 1,
          marketsSuggested: 1,
          marketsChosen: 2,
          marketsAccepted: 1,
        }),
      }),
    );
    expect((res.status as Mock)).toHaveBeenCalledWith(200);
    expect(result).toEqual({ data: { id: 'engine-company-1', industryCode: '28' } });
  });

  it('完成建档：理解仍在进行时 409，不写事实', async () => {
    const { controller, req, res, call } = fixture({
      tenant: { onboardingCompanyId: 'engine-company-1' },
      engineImpl: (method, path) => {
        if (method === 'GET' && path === '/companies/engine-company-1') {
          return { status: 200, body: { data: { id: 'engine-company-1', status: 'ENRICHING' } } };
        }
        return { status: 404, body: { error: { code: 'NOT_FOUND' } } };
      },
    });
    const error = await controller
      .createCompany(req, res, { name: '具安科技', products: ['A'], targetMarkets: ['DE'] })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      error: { code: 'ONBOARDING_UNDERSTANDING_IN_PROGRESS' },
    });
    expect(call).not.toHaveBeenCalledWith(
      expect.anything(),
      'POST',
      '/companies/engine-company-1/onboarding-facts',
      expect.anything(),
    );
  });

  it('industryCode 格式校验与 create 一致', async () => {
    const { controller, req, res } = fixture();
    await expect(
      controller.createCompany(req, res, { name: 'Acme', industryCode: 'bad code!' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('完成建档：已排队（DRAFT + 官网 + 无失败标记）409，不写事实', async () => {
    const { controller, req, res, call } = fixture({
      tenant: { onboardingCompanyId: 'engine-company-1' },
      engineImpl: (method, path) => {
        if (method === 'GET' && path === '/companies/engine-company-1') {
          return {
            status: 200,
            body: {
              data: {
                id: 'engine-company-1',
                status: 'DRAFT',
                website: 'https://acme.test',
                understandingFailedAt: null,
              },
            },
          };
        }
        return { status: 404, body: { error: { code: 'NOT_FOUND' } } };
      },
    });
    const error = await controller
      .createCompany(req, res, { name: '具安科技', products: ['A'], targetMarkets: ['DE'] })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      error: { code: 'ONBOARDING_UNDERSTANDING_IN_PROGRESS' },
    });
    expect(call).not.toHaveBeenCalledWith(
      expect.anything(),
      'POST',
      '/companies/engine-company-1/onboarding-facts',
      expect.anything(),
    );
  });

  it('启动预览：理解排队中改官网 409（旧网址已写进 outbox，改了也不会生效）', async () => {
    const { controller, req } = fixture({
      tenant: { onboardingCompanyId: 'engine-company-1' },
      engineImpl: (method, path) => {
        if (method === 'GET' && path === '/companies/engine-company-1') {
          return {
            status: 200,
            body: {
              data: {
                id: 'engine-company-1',
                name: '具安科技',
                website: 'https://acme.test',
                status: 'DRAFT',
                understandingFailedAt: null,
              },
            },
          };
        }
        return { status: 404, body: { error: { code: 'NOT_FOUND' } } };
      },
    });
    const error = await controller
      .startPreview(req, { website: 'https://other.test', name: '具安科技' })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      error: { code: 'ONBOARDING_UNDERSTANDING_IN_PROGRESS' },
    });
  });

  it('旧的一次性建档路径不接受 industryCode（引擎 quote 作用域不含该字段）', async () => {
    const { controller, req, res, issue } = fixture();
    await expect(
      controller.createCompany(req, res, { name: 'Acme', industryCode: '25' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(issue).not.toHaveBeenCalled();
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

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaService } from '../shared/prisma.service.js';
import { AuditService } from '../shared/audit.service.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { EngineHttp } from './engine-http.js';
import { EngineBudgetGrantService, EngineBudgetQuoteError } from './engine-budget-grant.service.js';
import { WorkspaceBudgetQuotaExceededError } from './workspace-budget-policy.service.js';

const TARGET_MARKET = /^[A-Z]{2}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * 注册引导(SD11)：把向导收集的事实经「quote → Grant → 引擎 POST /companies」建档，
 * 成功后记录 `onboarding_completed_at` 与引擎 CompanyProfile id。
 * 校验与引擎 CreateCompanyDto 同构（engine 仍是最终校验方）。
 */
function parseOnboardingBody(input: unknown): Record<string, unknown> {
  const invalid = (message: string): never => {
    throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
  };
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return invalid('请求体必须是对象');
  }
  const body = input as Record<string, unknown>;
  const allowed = new Set(['name', 'website', 'industry', 'targetMarkets', 'products', 'businessEmail']);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return invalid('请求体包含未知字段');
  }
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 200)) {
    return invalid('name 长度须为 1–200');
  }
  if (
    body.website !== undefined &&
    (typeof body.website !== 'string' || body.website.length < 1 || body.website.length > 2000)
  ) {
    return invalid('website 必须是 URL 字符串');
  }
  if (typeof body.name !== 'string' && typeof body.website !== 'string') {
    return invalid('企业名称与官网至少提供一个');
  }
  if (
    body.industry !== undefined &&
    (typeof body.industry !== 'string' || body.industry.length < 1 || body.industry.length > 120)
  ) {
    return invalid('industry 长度须为 1–120');
  }
  if (
    body.targetMarkets !== undefined &&
    (!Array.isArray(body.targetMarkets) ||
      body.targetMarkets.length > 20 ||
      !body.targetMarkets.every((m) => typeof m === 'string' && TARGET_MARKET.test(m)))
  ) {
    return invalid('targetMarkets 须为最多 20 个 ISO 3166-1 alpha-2 大写代码');
  }
  if (
    body.products !== undefined &&
    (!Array.isArray(body.products) ||
      body.products.length < 1 ||
      body.products.length > 5 ||
      !body.products.every((p) => typeof p === 'string' && p.length >= 1 && p.length <= 120))
  ) {
    return invalid('products 须为 1–5 个产品名称（每个 1–120 字符）');
  }
  if (
    body.businessEmail !== undefined &&
    (typeof body.businessEmail !== 'string' || body.businessEmail.length > 254 || !EMAIL.test(body.businessEmail))
  ) {
    return invalid('businessEmail 必须是合法邮箱');
  }
  return {
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.website === undefined ? {} : { website: body.website }),
    ...(body.industry === undefined ? {} : { industry: body.industry }),
    ...(body.targetMarkets === undefined ? {} : { targetMarkets: body.targetMarkets }),
    ...(body.products === undefined ? {} : { products: body.products }),
    ...(body.businessEmail === undefined ? {} : { businessEmail: body.businessEmail }),
  };
}

@Controller('api/onboarding')
@UseGuards(TenantGuard)
export class OnboardingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: EngineHttp,
    private readonly budget: EngineBudgetGrantService,
  ) {}

  @Get('status')
  async status(@Req() req: Request) {
    const tenant = req.tenant!;
    return {
      data: {
        complete: tenant.onboardingCompleted,
        companyId: tenant.onboardingCompanyId,
      },
    };
  }

  @Post('company')
  async createCompany(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() raw: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const tenant = req.tenant!;
    if (tenant.role !== 'admin') {
      throw new HttpException(
        { error: { code: 'FORBIDDEN', message: '只有管理员可以完成企业建档' } },
        403,
      );
    }
    if (tenant.onboardingCompleted) {
      throw new ConflictException({
        error: { code: 'ONBOARDING_ALREADY_COMPLETED', message: '该工作空间已完成引导建档' },
      });
    }
    const body = parseOnboardingBody(raw);
    let grant: string;
    try {
      grant = await this.budget.issue(tenant, { operation: 'POST /companies', body });
    } catch (err) {
      if (err instanceof WorkspaceBudgetQuotaExceededError) {
        throw new HttpException(
          { error: { code: err.code, message: err.message, details: err.details } },
          err.status,
        );
      }
      const quoteCode = err instanceof EngineBudgetQuoteError
        ? (err.engineBody as { error?: { code?: unknown } } | null)?.error?.code
        : undefined;
      const code =
        typeof quoteCode === 'string' && quoteCode.startsWith('EXECUTION_BUDGET_')
          ? quoteCode
          : 'EXECUTION_BUDGET_GRANT_FAILED';
      throw new HttpException(
        this.engine.toClientError(502, { error: { code, message: err instanceof Error ? err.message : String(err) } }),
        502,
      );
    }
    const headers: Record<string, string> = { 'x-execution-budget-grant': grant };
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

    let result;
    try {
      result = await this.engine.call(tenant, 'POST', '/companies', { body, headers });
    } catch (err) {
      throw new HttpException(
        this.engine.toClientError(502, { error: { code: 'MODEL_UPSTREAM_UNUSABLE', message: err instanceof Error ? err.message : String(err) } }),
        502,
      );
    }
    if (result.status >= 400) {
      const clientStatus = this.engine.toClientStatus(result.status, result.body);
      res.status(clientStatus);
      return this.engine.toClientError(result.status, result.body);
    }
    const companyId = (result.body as { data?: { id?: unknown } } | null)?.data?.id;
    if (typeof companyId !== 'string') {
      throw new HttpException(
        { error: { code: 'ONBOARDING_ENGINE_RESPONSE_INVALID', message: '引擎返回缺少企业档案 id' } },
        502,
      );
    }
    await this.prisma.workspace.update({
      where: { id: tenant.workspaceId },
      data: { onboardingCompletedAt: new Date(), onboardingCompanyId: companyId },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'onboarding.complete',
      target: tenant.workspaceId,
      detail: { companyId },
    });
    res.status(result.status);
    return result.body;
  }
}

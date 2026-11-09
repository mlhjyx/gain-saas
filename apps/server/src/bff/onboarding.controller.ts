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
import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { PrismaService } from '../shared/prisma.service.js';
import { AuditService } from '../shared/audit.service.js';
import { TenantGuard, type TenantRequestContext } from '../tenant/tenant.guard.js';
import { EngineHttp } from './engine-http.js';
import { EngineBudgetGrantService, EngineBudgetQuoteError } from './engine-budget-grant.service.js';
import { WorkspaceBudgetQuotaExceededError } from './workspace-budget-policy.service.js';

const TARGET_MARKET = /^[A-Z]{2}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const INDUSTRY_CODE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,31}$/;

/** 引擎 CompanyDto 的本端视图（只取向导用到的字段）。 */
interface EngineCompany {
  id: string;
  name?: string;
  website?: string | null;
  status?: string;
  industry?: string | null;
  industryCode?: string | null;
  understandingFailedAt?: string | null;
  understandingLastError?: string | null;
}

/** 引擎 GET /companies/:id/understanding-preview 的本端视图。 */
interface EnginePreview {
  companyId: string;
  name: string;
  website: string | null;
  status: string;
  state: 'not_started' | 'queued' | 'running' | 'ready' | 'failed';
  failure: { stage: string; code: string } | null;
  pagesAnalyzed: number;
  industry: {
    raw: string | null;
    suggested: {
      raw: string | null;
      code: string | null;
      label: string | null;
      labelEn: string | null;
      matched: boolean;
    };
    options: Array<{
      code: string;
      label: string;
      labelEn: string;
      labels?: Record<string, string>;
      parentCode?: string | null;
      nace?: string[];
    }>;
  };
  products: Array<{
    name: string;
    source?: string | null;
    sourceUrl?: string | null;
    evidence?: string | null;
  }>;
  markets: Array<{
    code: string;
    name: string;
    evidence: string;
    sourceUrl?: string | null;
  }>;
  updatedAt?: string;
}

interface OnboardingFacts {
  name?: string;
  industry?: string;
  industryCode?: string;
  targetMarkets?: string[];
  products?: string[];
  businessEmail?: string;
}

/**
 * 注册引导(SD11)：把向导收集的事实经「quote → Grant → 引擎 POST /companies」建档，
 * 成功后记录 `onboarding_completed_at` 与引擎 CompanyProfile id。
 * 校验与引擎 CreateCompanyDto 同构（engine 仍是最终校验方）。
 *
 * 2026-11-10「注册即建档」第 1 步：向导反转为 官网 → 理解预览 → 勾选完成。
 * - POST /onboarding/preview：先建/复用草稿档案（官网或名称），触发/重试理解；
 *   草稿 id 记入 onboardingCompanyId（不改 completedAt）。
 * - GET /onboarding/preview：恢复进行中的预览（透传引擎 understanding-preview）。
 * - POST /onboarding/company：把勾选事实写回同一档案（引擎 onboarding-facts）；
 *   没有草稿档案时保留旧的「一次性建档」路径（旧客户端/无预览）。
 */
function parseOnboardingBody(input: unknown): Record<string, unknown> {
  const invalid = (message: string): never => {
    throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
  };
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return invalid('请求体必须是对象');
  }
  const body = input as Record<string, unknown>;
  const allowed = new Set([
    'name',
    'website',
    'industry',
    'industryCode',
    'targetMarkets',
    'products',
    'businessEmail',
  ]);
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
  if (
    body.industry !== undefined &&
    (typeof body.industry !== 'string' || body.industry.length < 1 || body.industry.length > 120)
  ) {
    return invalid('industry 长度须为 1–120');
  }
  if (
    body.industryCode !== undefined &&
    (typeof body.industryCode !== 'string' || !INDUSTRY_CODE.test(body.industryCode))
  ) {
    return invalid('industryCode 格式不合法');
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
    ...(body.industryCode === undefined ? {} : { industryCode: body.industryCode }),
    ...(body.targetMarkets === undefined ? {} : { targetMarkets: body.targetMarkets }),
    ...(body.products === undefined ? {} : { products: body.products }),
    ...(body.businessEmail === undefined ? {} : { businessEmail: body.businessEmail }),
  };
}

/** 预览启动入参：官网与名称至少一个（无官网=手动模式，先建名称草稿拿受控词表）。 */
function parsePreviewBody(input: unknown): { website?: string; name?: string } {
  const invalid = (message: string): never => {
    throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
  };
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return invalid('请求体必须是对象');
  }
  const body = input as Record<string, unknown>;
  const allowed = new Set(['website', 'name']);
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
  if (typeof body.website !== 'string' && typeof body.name !== 'string') {
    return invalid('企业名称与官网至少提供一个');
  }
  return {
    ...(body.name === undefined ? {} : { name: body.name as string }),
    ...(body.website === undefined ? {} : { website: body.website as string }),
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

  /** 启动/恢复理解预览：建草稿档案（或复用既有草稿）并驱动一次理解。 */
  @Post('preview')
  async startPreview(@Req() req: Request, @Body() raw: unknown) {
    const tenant = req.tenant!;
    this.assertAdmin(tenant);
    this.assertNotCompleted(tenant);
    const input = parsePreviewBody(raw);
    // 同一工作空间 + 同一官网/名称的重复/并发启动复用同一次建档（引擎幂等键），
    // 避免超时重试或双击建出第二份草稿与第二条理解事件。
    const previewIdempotencyKey = `onboarding-preview:${createHash('sha256')
      .update(`${tenant.workspaceId}|${input.website ?? ''}|${input.name ?? ''}`)
      .digest('hex')}`;

    let companyId = tenant.onboardingCompanyId;
    let existing: EngineCompany | null = null;
    if (companyId) {
      const fetched = await this.callEngine(tenant, 'GET', `/companies/${companyId}`);
      if (fetched.status === 404) {
        companyId = null;
        await this.clearCompanyId(tenant.workspaceId);
      } else if (fetched.status >= 400) {
        throw this.engineHttpError(fetched.status, fetched.body);
      } else {
        existing = (fetched.body as { data?: EngineCompany } | null)?.data ?? null;
      }
    }

    if (companyId && existing) {
      if (existing.status === 'DRAFT') {
        // 理解已排队/进行中（有官网、无失败标记）时改官网不会生效：outbox 事件里是旧网址。
        // 直接给可执行的 409，等本轮结束后再改。
        const pending = Boolean(existing.website) && !existing.understandingFailedAt;
        if (
          pending &&
          input.website !== undefined &&
          input.website !== existing.website
        ) {
          throw new ConflictException({
            error: {
              code: 'ONBOARDING_UNDERSTANDING_IN_PROGRESS',
              message: '官网理解正在进行中，暂不能修改官网；等本轮结束后再改',
            },
          });
        }
        const patch: Record<string, string> = {};
        if (input.name !== undefined && input.name !== existing.name) patch.name = input.name;
        if (input.website !== undefined && input.website !== existing.website) patch.website = input.website;
        if (Object.keys(patch).length > 0) {
          const patched = await this.callEngine(tenant, 'PATCH', `/companies/${companyId}`, { body: patch });
          if (patched.status >= 400) throw this.engineHttpError(patched.status, patched.body);
        }
        const shouldStart =
          (patch.website !== undefined || Boolean(existing.understandingFailedAt)) &&
          Boolean(patch.website ?? existing.website);
        if (shouldStart) await this.startUnderstanding(tenant, companyId);
      }
    } else {
      const createBody: Record<string, string> = {
        ...(input.website === undefined ? {} : { website: input.website }),
        ...(input.name === undefined ? {} : { name: input.name }),
      };
      const grant = await this.issueGrant(tenant, { operation: 'POST /companies', body: createBody });
      const result = await this.callEngine(tenant, 'POST', '/companies', {
        body: createBody,
        headers: { 'x-execution-budget-grant': grant, 'idempotency-key': previewIdempotencyKey },
      });
      if (result.status >= 400) throw this.engineHttpError(result.status, result.body);
      const createdId = (result.body as { data?: { id?: unknown } } | null)?.data?.id;
      if (typeof createdId !== 'string') {
        throw new HttpException(
          { error: { code: 'ONBOARDING_ENGINE_RESPONSE_INVALID', message: '引擎返回缺少企业档案 id' } },
          502,
        );
      }
      companyId = createdId;
      await this.prisma.workspace.update({
        where: { id: tenant.workspaceId },
        data: { onboardingCompanyId: companyId },
      });
    }

    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'onboarding.preview_started',
      target: tenant.workspaceId,
      detail: {
        companyId,
        kind: input.website === undefined ? 'manual' : 'website',
      },
    });
    const preview = await this.fetchPreview(tenant, companyId);
    return { data: { started: true, preview } };
  }

  /** 恢复进行中的预览；没有草稿档案时 started=false，前端回到官网页。 */
  @Get('preview')
  async preview(@Req() req: Request) {
    const tenant = req.tenant!;
    if (tenant.onboardingCompleted) {
      throw new ConflictException({
        error: { code: 'ONBOARDING_ALREADY_COMPLETED', message: '该工作空间已完成引导建档' },
      });
    }
    const companyId = tenant.onboardingCompanyId;
    if (!companyId) return { data: { started: false } };
    const fetched = await this.callEngine(tenant, 'GET', `/companies/${companyId}`);
    if (fetched.status === 404) {
      await this.clearCompanyId(tenant.workspaceId);
      return { data: { started: false } };
    }
    if (fetched.status >= 400) throw this.engineHttpError(fetched.status, fetched.body);
    const preview = await this.fetchPreview(tenant, companyId);
    return { data: { started: true, preview } };
  }

  /** 完成建档：有草稿档案时把勾选事实写回同一档案；否则走旧的一次性建档。 */
  @Post('company')
  async createCompany(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() raw: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const tenant = req.tenant!;
    this.assertAdmin(tenant);
    this.assertNotCompleted(tenant);
    const body = parseOnboardingBody(raw);

    let companyId = tenant.onboardingCompanyId;
    if (companyId) {
      const fetched = await this.callEngine(tenant, 'GET', `/companies/${companyId}`);
      if (fetched.status === 404) {
        companyId = null;
        await this.clearCompanyId(tenant.workspaceId);
      } else if (fetched.status >= 400) {
        throw this.engineHttpError(fetched.status, fetched.body);
      } else {
        const company = (fetched.body as { data?: EngineCompany } | null)?.data ?? null;
        // ENRICHING，或 DRAFT + 有官网 + 无失败标记（已排队/刚接受重试）都不能写事实：
        // 后者虽然还是 DRAFT，但 understanding 的 extract_profile 稍后会改写 industry。
        const understandingPending =
          company?.status === 'ENRICHING' ||
          (company?.status === 'DRAFT' && Boolean(company.website) && !company.understandingFailedAt);
        if (understandingPending) {
          throw new ConflictException({
            error: {
              code: 'ONBOARDING_UNDERSTANDING_IN_PROGRESS',
              message: '官网理解还在进行中，请等预览就绪后再完成建档',
            },
          });
        }
      }
    }

    if (companyId) {
      const facts: OnboardingFacts = {
        ...(body.name === undefined ? {} : { name: body.name as string }),
        ...(body.industry === undefined ? {} : { industry: body.industry as string }),
        ...(body.industryCode === undefined ? {} : { industryCode: body.industryCode as string }),
        ...(body.targetMarkets === undefined ? {} : { targetMarkets: body.targetMarkets as string[] }),
        ...(body.products === undefined ? {} : { products: body.products as string[] }),
        ...(body.businessEmail === undefined ? {} : { businessEmail: body.businessEmail as string }),
      };
      const before = await this.fetchPreviewSafe(tenant, companyId);
      const result = await this.callEngine(tenant, 'POST', `/companies/${companyId}/onboarding-facts`, {
        body: facts,
      });
      if (result.status >= 400) throw this.engineHttpError(result.status, result.body);
      await this.prisma.workspace.update({
        where: { id: tenant.workspaceId },
        data: { onboardingCompletedAt: new Date(), onboardingCompanyId: companyId },
      });
      await this.audit.record({
        realm: 'tenant',
        actorId: tenant.userId,
        action: 'onboarding.complete',
        target: tenant.workspaceId,
        detail: { companyId, ...completionMetrics(before, facts) },
      });
      res.status(result.status);
      return result.body;
    }

    // 旧路径：没有预览草稿（旧客户端/直接提交）。保持原语义与幂等头。
    if (typeof body.name !== 'string' && typeof body.website !== 'string') {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: '企业名称与官网至少提供一个' },
      });
    }
    // 引擎 POST /companies 的 quote 作用域不认 industryCode（避免为此扩预算 schema）；
    // 受控行业必须走预览草稿 + onboarding-facts。
    if (body.industryCode !== undefined) {
      throw new BadRequestException({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'industryCode 只能通过理解预览完成建档提交，请先启动预览',
        },
      });
    }
    const grant = await this.issueGrant(tenant, { operation: 'POST /companies', body });
    const headers: Record<string, string> = { 'x-execution-budget-grant': grant };
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

    let result;
    try {
      result = await this.callEngine(tenant, 'POST', '/companies', { body, headers });
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
    const createdCompanyId = (result.body as { data?: { id?: unknown } } | null)?.data?.id;
    if (typeof createdCompanyId !== 'string') {
      throw new HttpException(
        { error: { code: 'ONBOARDING_ENGINE_RESPONSE_INVALID', message: '引擎返回缺少企业档案 id' } },
        502,
      );
    }
    await this.prisma.workspace.update({
      where: { id: tenant.workspaceId },
      data: { onboardingCompletedAt: new Date(), onboardingCompanyId: createdCompanyId },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'onboarding.complete',
      target: tenant.workspaceId,
      detail: { companyId: createdCompanyId },
    });
    res.status(result.status);
    return result.body;
  }

  private assertAdmin(tenant: TenantRequestContext): void {
    if (tenant.role !== 'admin') {
      throw new HttpException(
        { error: { code: 'FORBIDDEN', message: '只有管理员可以完成企业建档' } },
        403,
      );
    }
  }

  private assertNotCompleted(tenant: TenantRequestContext): void {
    if (tenant.onboardingCompleted) {
      throw new ConflictException({
        error: { code: 'ONBOARDING_ALREADY_COMPLETED', message: '该工作空间已完成引导建档' },
      });
    }
  }

  private async clearCompanyId(workspaceId: string): Promise<void> {
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { onboardingCompanyId: null },
    });
  }

  /** quote → Grant；配额与 quote 失败按既有三层文案降级。 */
  private async issueGrant(
    tenant: TenantRequestContext,
    quoteRequest: Record<string, unknown>,
  ): Promise<string> {
    try {
      return await this.budget.issue(tenant, quoteRequest);
    } catch (err) {
      if (err instanceof WorkspaceBudgetQuotaExceededError) {
        throw new HttpException(
          this.engine.toClientError(err.status, { error: { code: err.code, message: err.message } }),
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
  }

  /** 为失败/未启动的草稿重启一次理解（quote 绑定 attemptId，与引擎 scope 同构）。 */
  private async startUnderstanding(tenant: TenantRequestContext, companyId: string): Promise<void> {
    const attemptId = randomUUID();
    const grant = await this.issueGrant(tenant, {
      operation: 'POST /companies/:companyId/understanding/retry',
      companyId,
      body: { attemptId },
    });
    const result = await this.callEngine(tenant, 'POST', `/companies/${companyId}/understanding/retry`, {
      body: { attemptId },
      headers: { 'x-execution-budget-grant': grant },
    });
    if (result.status >= 400) {
      const code = (result.body as { error?: { code?: unknown } } | null)?.error?.code;
      if (code === 'UNDERSTANDING_ALREADY_PENDING') return; // 上一轮还在排队/进行中，直接返回当前状态
      throw this.engineHttpError(result.status, result.body);
    }
  }

  /** 网络/连接失败统一折算成 502 三层文案（与旧建档路径一致），不让 Nest 抛裸 500。 */
  private async callEngine(
    tenant: TenantRequestContext,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options: Parameters<EngineHttp['call']>[3] = {},
  ) {
    try {
      return await this.engine.call(tenant, method, path, options);
    } catch (err) {
      throw new HttpException(
        this.engine.toClientError(502, {
          error: {
            code: 'MODEL_UPSTREAM_UNUSABLE',
            message: err instanceof Error ? err.message : String(err),
          },
        }),
        502,
      );
    }
  }

  private async fetchPreview(tenant: TenantRequestContext, companyId: string): Promise<EnginePreview> {
    const result = await this.callEngine(tenant, 'GET', `/companies/${companyId}/understanding-preview`);
    if (result.status >= 400) throw this.engineHttpError(result.status, result.body);
    const preview = (result.body as { data?: EnginePreview } | null)?.data;
    if (!preview || typeof preview !== 'object') {
      throw new HttpException(
        { error: { code: 'ONBOARDING_PREVIEW_INVALID', message: '引擎返回缺少理解预览' } },
        502,
      );
    }
    return preview;
  }

  private async fetchPreviewSafe(
    tenant: TenantRequestContext,
    companyId: string,
  ): Promise<EnginePreview | null> {
    try {
      return await this.fetchPreview(tenant, companyId);
    } catch {
      return null; // 指标采集失败不阻断建档
    }
  }

  private engineHttpError(status: number, body: unknown): HttpException {
    return new HttpException(
      this.engine.toClientError(status, body),
      this.engine.toClientStatus(status, body),
    );
  }
}

/** 完成时记录「建议 vs 勾选」的差异（指标：修正率/接受率）；只留计数与代码，不留原文。 */
function completionMetrics(
  before: EnginePreview | null,
  facts: OnboardingFacts,
): Record<string, unknown> {
  if (!before) return { metrics: 'unavailable' };
  const suggestedProducts = before.products.map((item) => item.name);
  const suggestedMarkets = before.markets.map((item) => item.code);
  const suggestedIndustry = before.industry.suggested.code;
  const chosenProducts = facts.products ?? [];
  const chosenMarkets = facts.targetMarkets ?? [];
  return {
    understandingState: before.state,
    pagesAnalyzed: before.pagesAnalyzed,
    industrySuggested: suggestedIndustry,
    industryChosen: facts.industryCode ?? null,
    industryAccepted: suggestedIndustry !== null && facts.industryCode === suggestedIndustry,
    productsSuggested: suggestedProducts.length,
    productsChosen: chosenProducts.length,
    productsAccepted: chosenProducts.filter((name) => suggestedProducts.includes(name)).length,
    marketsSuggested: suggestedMarkets.length,
    marketsChosen: chosenMarkets.length,
    marketsAccepted: chosenMarkets.filter((code) => suggestedMarkets.includes(code)).length,
  };
}

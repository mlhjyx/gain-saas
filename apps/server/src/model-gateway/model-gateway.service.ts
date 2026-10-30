import { randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import { SecretBox } from './secret-box.js';

type ProviderRow = {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyCipher: string;
  headers: Prisma.JsonValue | null;
  enabled: boolean;
  priority: number;
  timeoutMs: number;
  minOutputTokens: number | null;
  maxTokensField: string;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type RouteRow = {
  id: string;
  providerId: string;
  alias: string;
  upstreamModel: string;
  enabled: boolean;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  provider?: { name: string };
};

const providerFields = {
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().trim().url().max(500),
  // 本地 Ollama 之类可以没有 Key;托管厂商仍由前端要求必填。
  apiKey: z.string().trim().max(4000).optional(),
  headers: z.record(z.string(), z.string().max(2000)).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(1).max(10_000).optional(),
  timeoutMs: z.number().int().min(5_000).max(600_000).optional(),
  minOutputTokens: z.number().int().min(1).max(200_000).nullable().optional(),
  maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  note: z.string().trim().max(500).optional(),
};

const providerInput = z.object(providerFields);

const providerCreate = z.object({
  ...providerFields,
  /** 保存厂商时一并设为首选模型:自动创建一条 default 路由,所有引擎任务兜底使用。 */
  defaultModel: z.string().trim().min(1).max(160).optional(),
});

const providerPatch = providerInput.partial();

const probeInput = z.object({
  baseUrl: z.string().trim().url().max(500),
  apiKey: z.string().trim().max(4000).optional(),
  headers: z.record(z.string(), z.string().max(2000)).optional(),
  model: z.string().trim().min(1).max(160).optional(),
  maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
});

const routeInput = z.object({
  providerId: z.string().uuid(),
  alias: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/, '模型别名只允许字母数字与 . _ : / -'),
  upstreamModel: z.string().trim().min(1).max(160),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

const chatInput = z.object({
  model: z.string().trim().min(1).max(120),
  messages: z
    .array(z.object({ role: z.string().min(1).max(40), content: z.unknown() }).passthrough())
    .min(1)
    .max(100),
  max_tokens: z.number().int().min(1).max(200_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  response_format: z.record(z.string(), z.unknown()).optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high']).optional(),
  stream: z.boolean().optional(),
});

function validationError(error: z.ZodError): BadRequestException {
  return new BadRequestException({
    error: { code: 'VALIDATION', message: error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ') },
  });
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('PROVIDER_URL_PROTOCOL');
  if (url.username || url.password) throw new Error('PROVIDER_URL_CREDENTIALS');
  return value.replace(/\/+$/, '');
}

function maskKey(cipher: string): string {
  // 不返回密文或明文;运维只需要知道"已配置"以及末四位校验录入是否正确。
  return '••••••••';
}

function openAiError(message: string, code: string, status: number): { status: number; body: unknown; headers: Record<string, string> } {
  return {
    status,
    body: { error: { message, type: status >= 500 ? 'upstream_error' : 'invalid_request_error', code } },
    headers: {},
  };
}

@Injectable()
export class ModelGatewayService {
  private readonly secretBox: SecretBox;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    this.secretBox = new SecretBox(config.MODEL_GATEWAY_ENC_KEY ?? config.SESSION_SECRET);
  }

  configured(): boolean {
    return Boolean(this.config.MODEL_GATEWAY_API_KEY);
  }

  private mapProvider(provider: ProviderRow) {
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKeyMasked: maskKey(provider.apiKeyCipher),
      headers: provider.headers,
      enabled: provider.enabled,
      priority: provider.priority,
      timeoutMs: provider.timeoutMs,
      minOutputTokens: provider.minOutputTokens,
      maxTokensField: provider.maxTokensField,
      note: provider.note,
      createdAt: provider.createdAt.toISOString(),
      updatedAt: provider.updatedAt.toISOString(),
    };
  }

  private mapRoute(route: RouteRow) {
    return {
      id: route.id,
      providerId: route.providerId,
      providerName: route.provider?.name ?? null,
      alias: route.alias,
      upstreamModel: route.upstreamModel,
      enabled: route.enabled,
      isDefault: route.isDefault,
      createdAt: route.createdAt.toISOString(),
      updatedAt: route.updatedAt.toISOString(),
    };
  }

  async overview() {
    const [providers, routes, calls, stats] = await Promise.all([
      this.prisma.aiProvider.findMany({ orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] }),
      this.prisma.aiModelRoute.findMany({ include: { provider: { select: { name: true } } }, orderBy: [{ alias: 'asc' }] }),
      this.prisma.modelCallLog.findMany({ orderBy: { at: 'desc' }, take: 100 }),
      this.prisma.modelCallLog.groupBy({ by: ['status'], _count: { _all: true }, where: { at: { gte: new Date(Date.now() - 24 * 3600_000) } } }),
    ]);
    return {
      gateway: {
        configured: this.configured(),
        endpoint: '/v1',
        chatPath: '/v1/chat/completions',
        engineEnv: 'MODEL_GATEWAY_URL=http://127.0.0.1:4020/v1',
      },
      providers: providers.map((provider) => this.mapProvider(provider)),
      routes: routes.map((route) => this.mapRoute(route)),
      calls: calls.map((call) => ({
        ...call,
        at: call.at.toISOString(),
        providerName: providers.find((provider) => provider.id === call.providerId)?.name ?? null,
      })),
      stats24h: Object.fromEntries(stats.map((row) => [row.status, row._count._all])),
    };
  }

  async createProvider(input: unknown, actorId: string) {
    const parsed = providerCreate.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    let baseUrl: string;
    try {
      baseUrl = normalizeBaseUrl(parsed.data.baseUrl);
    } catch {
      throw new BadRequestException({ error: { code: 'VALIDATION', message: 'baseUrl 必须是 http(s) URL 且不能带账号密码' } });
    }
    // 预制厂商允许重复添加(不同 Key);名称冲突时自动加序号,避免运营停下来想名字。
    const baseName = parsed.data.name;
    let name = baseName;
    for (let index = 2; index <= 50; index += 1) {
      const exists = await this.prisma.aiProvider.findUnique({ where: { name } });
      if (!exists) break;
      name = `${baseName} ${index}`;
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const provider = await tx.aiProvider.create({
        data: {
          name,
          baseUrl,
          apiKeyCipher: this.secretBox.encrypt(parsed.data.apiKey ?? ''),
          headers: (parsed.data.headers ?? undefined) as Prisma.InputJsonValue | undefined,
          enabled: parsed.data.enabled ?? true,
          priority: parsed.data.priority ?? 100,
          timeoutMs: parsed.data.timeoutMs ?? this.config.MODEL_GATEWAY_TIMEOUT_MS,
          maxTokensField: parsed.data.maxTokensField ?? 'max_tokens',
          note: parsed.data.note,
        },
      });
      let defaultRoute = null;
      if (parsed.data.defaultModel) {
        await tx.aiModelRoute.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
        defaultRoute = await tx.aiModelRoute.create({
          data: {
            providerId: provider.id,
            alias: 'default',
            upstreamModel: parsed.data.defaultModel,
            enabled: true,
            isDefault: true,
          },
          include: { provider: { select: { name: true } } },
        });
      }
      return { provider, defaultRoute };
    });
    await this.audit.record({
      realm: 'ops',
      actorId,
      action: 'model-provider.create',
      target: created.provider.name,
      detail: { baseUrl: created.provider.baseUrl, priority: created.provider.priority, defaultModel: parsed.data.defaultModel },
    });
    return {
      provider: this.mapProvider(created.provider),
      defaultRoute: created.defaultRoute ? this.mapRoute(created.defaultRoute) : null,
    };
  }

  async updateProvider(id: string, input: unknown, actorId: string) {
    const parsed = providerPatch.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    const before = await this.prisma.aiProvider.findUnique({ where: { id } });
    if (!before) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: '厂商不存在' } });
    const data: Prisma.AiProviderUpdateInput = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.baseUrl !== undefined) {
      try {
        data.baseUrl = normalizeBaseUrl(parsed.data.baseUrl);
      } catch {
        throw new BadRequestException({ error: { code: 'VALIDATION', message: 'baseUrl 必须是 http(s) URL 且不能带账号密码' } });
      }
    }
    if (parsed.data.apiKey !== undefined) data.apiKeyCipher = this.secretBox.encrypt(parsed.data.apiKey);
    if (parsed.data.headers !== undefined) data.headers = parsed.data.headers as Prisma.InputJsonValue;
    if (parsed.data.enabled !== undefined) data.enabled = parsed.data.enabled;
    if (parsed.data.priority !== undefined) data.priority = parsed.data.priority;
    if (parsed.data.timeoutMs !== undefined) data.timeoutMs = parsed.data.timeoutMs;
    if (parsed.data.minOutputTokens !== undefined) data.minOutputTokens = parsed.data.minOutputTokens;
    if (parsed.data.maxTokensField !== undefined) data.maxTokensField = parsed.data.maxTokensField;
    if (parsed.data.note !== undefined) data.note = parsed.data.note;
    if (Object.keys(data).length === 0) {
      throw new BadRequestException({ error: { code: 'VALIDATION', message: '没有可更新字段' } });
    }
    try {
      const updated = await this.prisma.aiProvider.update({ where: { id }, data });
      await this.audit.record({ realm: 'ops', actorId, action: 'model-provider.update', target: updated.name, detail: { before: { name: before.name, enabled: before.enabled, priority: before.priority }, after: { name: updated.name, enabled: updated.enabled, priority: updated.priority } } });
      return { provider: this.mapProvider(updated) };
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException({ error: { code: 'DUPLICATE', message: '厂商名称已存在' } });
      }
      throw error;
    }
  }

  async deleteProvider(id: string, actorId: string) {
    const provider = await this.prisma.aiProvider.findUnique({ where: { id }, include: { routes: true } });
    if (!provider) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: '厂商不存在' } });
    await this.prisma.aiProvider.delete({ where: { id } });
    await this.audit.record({ realm: 'ops', actorId, action: 'model-provider.delete', target: provider.name, detail: { routes: provider.routes.length } });
    return { deleted: provider.name };
  }

  async createRoute(input: unknown, actorId: string) {
    const parsed = routeInput.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    const provider = await this.prisma.aiProvider.findUnique({ where: { id: parsed.data.providerId } });
    if (!provider) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: '厂商不存在' } });
    const duplicate = await this.prisma.aiModelRoute.findUnique({
      where: { alias_providerId: { alias: parsed.data.alias, providerId: parsed.data.providerId } },
    });
    if (duplicate) throw new ConflictException({ error: { code: 'DUPLICATE', message: `该厂商下已有别名 ${parsed.data.alias}` } });
    const created = await this.prisma.$transaction(async (tx) => {
      if (parsed.data.isDefault) await tx.aiModelRoute.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      return tx.aiModelRoute.create({
        data: {
          providerId: parsed.data.providerId,
          alias: parsed.data.alias,
          upstreamModel: parsed.data.upstreamModel,
          enabled: parsed.data.enabled ?? true,
          isDefault: parsed.data.isDefault ?? false,
        },
        include: { provider: { select: { name: true } } },
      });
    });
    await this.audit.record({ realm: 'ops', actorId, action: 'model-route.create', target: `${created.alias}→${created.upstreamModel}`, detail: { provider: provider.name, isDefault: created.isDefault } });
    return { route: this.mapRoute(created) };
  }

  async updateRoute(id: string, input: unknown, actorId: string) {
    const parsed = routeInput.partial().safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    const before = await this.prisma.aiModelRoute.findUnique({ where: { id }, include: { provider: { select: { name: true } } } });
    if (!before) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: '模型路由不存在' } });
    if (parsed.data.providerId && parsed.data.providerId !== before.providerId) {
      throw new BadRequestException({ error: { code: 'VALIDATION', message: '模型路由不能改厂商;请删除后新建' } });
    }
    const data: Prisma.AiModelRouteUpdateInput = {};
    if (parsed.data.alias !== undefined) data.alias = parsed.data.alias;
    if (parsed.data.upstreamModel !== undefined) data.upstreamModel = parsed.data.upstreamModel;
    if (parsed.data.enabled !== undefined) data.enabled = parsed.data.enabled;
    if (parsed.data.isDefault !== undefined) data.isDefault = parsed.data.isDefault;
    if (Object.keys(data).length === 0) throw new BadRequestException({ error: { code: 'VALIDATION', message: '没有可更新字段' } });
    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        if (parsed.data.isDefault) await tx.aiModelRoute.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } });
        return tx.aiModelRoute.update({ where: { id }, data, include: { provider: { select: { name: true } } } });
      });
      await this.audit.record({ realm: 'ops', actorId, action: 'model-route.update', target: `${updated.alias}→${updated.upstreamModel}`, detail: { provider: updated.provider.name, enabled: updated.enabled, isDefault: updated.isDefault } });
      return { route: this.mapRoute(updated) };
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException({ error: { code: 'DUPLICATE', message: '同一厂商下别名重复' } });
      }
      throw error;
    }
  }

  async deleteRoute(id: string, actorId: string) {
    const route = await this.prisma.aiModelRoute.findUnique({ where: { id } });
    if (!route) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: '模型路由不存在' } });
    await this.prisma.aiModelRoute.delete({ where: { id } });
    await this.audit.record({ realm: 'ops', actorId, action: 'model-route.delete', target: `${route.alias}→${route.upstreamModel}` });
    return { deleted: route.alias };
  }

  private resolveHeaders(provider: ProviderRow, apiKey: string): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (provider.headers && typeof provider.headers === 'object' && !Array.isArray(provider.headers)) {
      for (const [key, value] of Object.entries(provider.headers as Record<string, unknown>)) {
        if (typeof value === 'string' && !['authorization', 'content-type'].includes(key.toLowerCase())) headers[key] = value;
      }
    }
    headers.authorization = `Bearer ${apiKey}`;
    return headers;
  }

  private async logCall(input: {
    requestId: string;
    providerId: string | null;
    alias: string;
    upstreamModel: string;
    status: 'OK' | 'ERROR';
    httpStatus: number | null;
    latencyMs: number;
    inputTokens?: number | null;
    outputTokens?: number | null;
    error?: string | null;
  }): Promise<void> {
    await this.prisma.modelCallLog
      .create({
        data: {
          requestId: input.requestId,
          providerId: input.providerId,
          alias: input.alias,
          upstreamModel: input.upstreamModel,
          status: input.status,
          httpStatus: input.httpStatus,
          latencyMs: input.latencyMs,
          inputTokens: input.inputTokens ?? null,
          outputTokens: input.outputTokens ?? null,
          error: input.error?.slice(0, 1000) ?? null,
        },
      })
      .catch(() => undefined);
  }

  private candidates(alias: string) {
    return this.prisma.aiModelRoute.findMany({
      where: { alias, enabled: true, provider: { enabled: true } },
      include: { provider: true },
      orderBy: [{ provider: { priority: 'asc' } }, { createdAt: 'asc' }],
    });
  }

  private settlementProxyReady(): boolean {
    return Boolean(this.config.MODEL_GATEWAY_SETTLEMENT_ORIGIN && this.config.MODEL_GATEWAY_SETTLEMENT_API_KEY);
  }

  private hasSettlementHeaders(headers: Record<string, string | string[] | undefined>): boolean {
    return Boolean(headers['x-new-api-settlement-request-id'] || headers['x-new-api-settlement-nonce']);
  }

  /**
   * 站点构建的 settled 模型调用仍由 new-api 处理:引擎会带
   * X-New-API-Settlement-Request-Id/Nonce,原样转给 new-api 才能生成读回回执。
   */
  async proxySettlement(
    path: string,
    body: unknown,
    incomingHeaders: Record<string, string | string[] | undefined>,
  ): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
    const origin = this.config.MODEL_GATEWAY_SETTLEMENT_ORIGIN?.replace(/\/+$/, '');
    const apiKey = this.config.MODEL_GATEWAY_SETTLEMENT_API_KEY;
    if (!origin || !apiKey) {
      return openAiError('站点构建结算代理未配置(MODEL_GATEWAY_SETTLEMENT_ORIGIN/API_KEY)', 'settlement_proxy_unavailable', 503);
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    };
    for (const key of [
      'x-new-api-settlement-request-id',
      'x-new-api-settlement-nonce',
      'accept',
      'anthropic-version',
      'x-api-key',
    ]) {
      const value = incomingHeaders[key];
      if (typeof value === 'string' && value) headers[key] = value;
    }
    try {
      const response = await fetch(`${origin}/v1/${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(this.config.MODEL_GATEWAY_TIMEOUT_MS, 60_000)),
      });
      const text = await response.text();
      let parsed: unknown = text;
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('json')) {
        try { parsed = JSON.parse(text); } catch { parsed = text; }
      }
      const responseHeaders: Record<string, string> = {};
      for (const key of ['x-oneapi-request-id', 'x-new-api-settlement-contract', 'content-type', 'cache-control']) {
        const value = response.headers.get(key);
        if (value) responseHeaders[key] = value;
      }
      return { status: response.status, body: parsed, headers: responseHeaders };
    } catch (error) {
      return openAiError(`站点构建代理调用 new-api 失败:${error instanceof Error ? error.message : String(error)}`, 'settlement_proxy_unavailable', 502);
    }
  }

  async chatCompletion(
    input: unknown,
    incomingHeaders: Record<string, string | string[] | undefined> = {},
  ): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
    if (!this.configured()) {
      throw new ServiceUnavailableException({ error: { message: '模型网关未启用:配置 MODEL_GATEWAY_API_KEY 后重启', type: 'gateway_error', code: 'gateway_disabled' } });
    }
    if (this.hasSettlementHeaders(incomingHeaders)) {
      return this.proxySettlement('chat/completions', input, incomingHeaders);
    }
    const parsed = chatInput.safeParse(input);
    if (!parsed.success) return openAiError(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '), 'invalid_request', 400);
    if (parsed.data.stream) return openAiError('本网关暂不支持流式调用;请把引擎 MODEL_GATEWAY_STREAM_CHAT_COMPLETIONS 设为 false', 'stream_unsupported', 400);
    const requestId = randomUUID();
    const alias = parsed.data.model;
    let routes = await this.candidates(alias);
    if (routes.length === 0) {
      routes = await this.prisma.aiModelRoute.findMany({
        where: { isDefault: true, enabled: true, provider: { enabled: true } },
        include: { provider: true },
        orderBy: [{ provider: { priority: 'asc' } }, { createdAt: 'asc' }],
      });
    }
    if (routes.length === 0) {
      await this.logCall({ requestId, providerId: null, alias, upstreamModel: '', status: 'ERROR', httpStatus: 404, latencyMs: 0, error: 'no route or default route' });
      return openAiError(`没有可用的模型路由:${alias}(请给该别名配路由或设置默认路由)`, 'model_not_found', 404);
    }
    let lastStatus = 502;
    let lastMessage = 'upstream failed';
    for (const route of routes) {
      const provider = route.provider as ProviderRow;
      let apiKey: string;
      try {
        apiKey = this.secretBox.decrypt(provider.apiKeyCipher);
      } catch {
        lastMessage = `厂商 ${provider.name} 的 API Key 无法解密(检查 MODEL_GATEWAY_ENC_KEY)`;
        lastStatus = 502;
        continue;
      }
      const requestedMax = parsed.data.max_tokens ?? 0;
      const effectiveMax = Math.max(requestedMax, provider.minOutputTokens ?? 0);
      const body: Record<string, unknown> = {
        model: route.upstreamModel,
        messages: parsed.data.messages,
        ...(effectiveMax > 0 ? { [provider.maxTokensField]: effectiveMax } : {}),
        ...(parsed.data.temperature !== undefined ? { temperature: parsed.data.temperature } : {}),
        ...(parsed.data.response_format !== undefined ? { response_format: parsed.data.response_format } : {}),
        ...(parsed.data.reasoning_effort !== undefined ? { reasoning_effort: parsed.data.reasoning_effort } : {}),
      };
      const started = Date.now();
      try {
        const response = await fetch(`${provider.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.resolveHeaders(provider, apiKey),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(provider.timeoutMs),
        });
        const latencyMs = Date.now() - started;
        if (!response.ok) {
          const text = (await response.text().catch(() => '')).slice(0, 2000);
          lastStatus = response.status;
          lastMessage = `厂商 ${provider.name} HTTP ${response.status}: ${text || response.statusText}`;
          await this.logCall({ requestId, providerId: provider.id, alias, upstreamModel: route.upstreamModel, status: 'ERROR', httpStatus: response.status, latencyMs, error: lastMessage });
          continue;
        }
        const upstream = (await response.json().catch(() => null)) as Record<string, any> | null;
        if (!upstream || !Array.isArray(upstream.choices) || upstream.choices.length === 0) {
          lastStatus = 502;
          lastMessage = `厂商 ${provider.name} 返回体缺少 choices`;
          await this.logCall({ requestId, providerId: provider.id, alias, upstreamModel: route.upstreamModel, status: 'ERROR', httpStatus: response.status, latencyMs, error: lastMessage });
          continue;
        }
        await this.logCall({
          requestId,
          providerId: provider.id,
          alias,
          upstreamModel: route.upstreamModel,
          status: 'OK',
          httpStatus: response.status,
          latencyMs,
          inputTokens: upstream.usage?.prompt_tokens,
          outputTokens: upstream.usage?.completion_tokens,
        });
        return {
          status: 200,
          body: { ...upstream, model: alias },
          headers: {
            'x-gateway-request-id': requestId,
            'x-oneapi-request-id': requestId,
            'x-gateway-provider': provider.name,
          },
        };
      } catch (error) {
        lastStatus = 502;
        lastMessage = `厂商 ${provider.name} 调用失败:${error instanceof Error ? error.message : String(error)}`;
        await this.logCall({ requestId, providerId: provider.id, alias, upstreamModel: route.upstreamModel, status: 'ERROR', httpStatus: null, latencyMs: Date.now() - started, error: lastMessage });
        // 超时代表上游可能已计费/仍在生成;换厂商重试会造成重复扣费,直接返回。
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) break;
      }
    }
    const status = lastStatus >= 400 && lastStatus < 500 ? lastStatus : 502;
    return openAiError(lastMessage, 'upstream_error', status);
  }

  async listPublicModels(): Promise<{ models: string[] }> {
    const routes = await this.prisma.aiModelRoute.findMany({
      where: { enabled: true, provider: { enabled: true } },
      select: { alias: true },
      distinct: ['alias'],
      orderBy: { alias: 'asc' },
    });
    return { models: routes.map((route) => route.alias) };
  }

  private async fetchUpstreamModels(
    baseUrl: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<string[]> {
    const response = await fetch(`${baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(Math.min(timeoutMs, 20_000)),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    const all = (body.data ?? []).map((item) => item.id).filter((value): value is string => typeof value === 'string');
    // 多数 /models 会混入 embedding/rerank/语音模型;先只展示可对话模型,过滤后为空再退回全集。
    const chat = all.filter((id) => !/embed|rerank|whisper|tts|dall|image|moderation|stable-diffusion/i.test(id));
    return chat.length > 0 ? chat : all;
  }

  private probeShape(input: z.infer<typeof probeInput>) {
    let baseUrl: string;
    try {
      baseUrl = normalizeBaseUrl(input.baseUrl);
    } catch {
      throw new BadRequestException({ error: { code: 'VALIDATION', message: 'baseUrl 必须是 http(s) URL 且不能带账号密码' } });
    }
    const provider: ProviderRow = {
      id: 'probe',
      name: 'probe',
      baseUrl,
      apiKeyCipher: '',
      headers: (input.headers ?? null) as Prisma.JsonValue | null,
      enabled: true,
      priority: 0,
      timeoutMs: 30_000,
      minOutputTokens: null,
      maxTokensField: input.maxTokensField ?? 'max_tokens',
      note: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    return { baseUrl, provider };
  }

  /**
   * 未保存厂商的连通性探测:GET /models 拉模型 + 用选中的/第一个模型发最小 chat。
   * 保存前先测,避免运营创建一个不可用的厂商。
   */
  async probeProvider(input: unknown): Promise<Record<string, unknown>> {
    const parsed = probeInput.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    const { baseUrl, provider } = this.probeShape(parsed.data);
    const apiKey = parsed.data.apiKey ?? '';
    const headers = this.resolveHeaders(provider, apiKey);
    let models: string[] = [];
    let modelsError: string | null = null;
    try {
      models = await this.fetchUpstreamModels(baseUrl, headers, provider.timeoutMs);
    } catch (error) {
      modelsError = error instanceof Error ? error.message : String(error);
    }
    const testModel = parsed.data.model?.trim() || models[0];
    if (!testModel) {
      return { ok: false, models, modelsError, error: modelsError ?? '上游没有返回可用模型' };
    }
    const started = Date.now();
    try {
      const body: Record<string, unknown> = {
        model: testModel,
        messages: [{ role: 'user', content: '只回复 OK' }],
        temperature: 0,
      };
      body[provider.maxTokensField] = 8;
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(provider.timeoutMs),
      });
      const latencyMs = Date.now() - started;
      const text = await response.text();
      if (!response.ok) {
        return { ok: false, models, modelsError, latencyMs, testModel, testError: text.slice(0, 500) };
      }
      const parsedBody = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
      return {
        ok: true,
        models,
        modelsError,
        latencyMs,
        testModel,
        testContent: parsedBody.choices?.[0]?.message?.content ?? '',
      };
    } catch (error) {
      return {
        ok: false,
        models,
        modelsError,
        latencyMs: Date.now() - started,
        testModel,
        testError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async testProvider(id: string, model?: string, apiKeyOverride?: string): Promise<Record<string, unknown>> {
    const provider = await this.prisma.aiProvider.findUnique({ where: { id }, include: { routes: { orderBy: { createdAt: 'asc' } } } });
    if (!provider) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: '厂商不存在' } });
    const upstreamModel =
      model?.trim() ||
      provider.routes.find((route) => route.isDefault)?.upstreamModel ||
      provider.routes[0]?.upstreamModel;
    let apiKey: string;
    try {
      apiKey = apiKeyOverride?.trim() || this.secretBox.decrypt(provider.apiKeyCipher);
    } catch {
      return { ok: false, error: 'API Key 无法解密(检查 MODEL_GATEWAY_ENC_KEY)' };
    }
    const headers = this.resolveHeaders(provider as ProviderRow, apiKey);
    let models: string[] = [];
    let modelsError: string | null = null;
    try {
      models = await this.fetchUpstreamModels(provider.baseUrl, headers, provider.timeoutMs);
    } catch (error) {
      modelsError = error instanceof Error ? error.message : String(error);
    }
    const testModel = upstreamModel || models[0];
    if (!testModel) {
      return { ok: false, models, modelsError, error: '该厂商还没有模型,请选择或填写一个模型' };
    }
    const started = Date.now();
    try {
      const testBody: Record<string, unknown> = {
        model: testModel,
        messages: [{ role: 'user', content: '只回复 OK' }],
        temperature: 0,
      };
      testBody[provider.maxTokensField] = Math.max(8, provider.minOutputTokens ?? 0);
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(testBody),
        signal: AbortSignal.timeout(Math.min(provider.timeoutMs, 60_000)),
      });
      const latencyMs = Date.now() - started;
      const text = await response.text();
      if (!response.ok) return { ok: false, status: response.status, latencyMs, models, modelsError, model: testModel, error: text.slice(0, 500) };
      const body = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
      return {
        ok: true,
        latencyMs,
        models,
        modelsError,
        model: testModel,
        content: body.choices?.[0]?.message?.content ?? '',
      };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, models, modelsError, model: testModel, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async listProviderModels(id: string): Promise<{ models: string[] }> {
    const provider = await this.prisma.aiProvider.findUnique({ where: { id } });
    if (!provider) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: '厂商不存在' } });
    let apiKey: string;
    try {
      apiKey = this.secretBox.decrypt(provider.apiKeyCipher);
    } catch {
      throw new BadGatewayException({ error: { code: 'KEY_UNREADABLE', message: 'API Key 无法解密' } });
    }
    try {
      const models = await this.fetchUpstreamModels(
        provider.baseUrl,
        this.resolveHeaders(provider as ProviderRow, apiKey),
        provider.timeoutMs,
      );
      return { models };
    } catch (error) {
      throw new BadGatewayException({ error: { code: 'MODELS_UNAVAILABLE', message: `上游 /models 不可用:${error instanceof Error ? error.message : String(error)}` } });
    }
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { ModelGatewayService } from './model-gateway.service.js';
import { SecretBox } from './secret-box.js';

const ENC = 'gateway-test-encryption-material-0123456789';
const box = new SecretBox(ENC);

function config(): AppConfig {
  return {
    MODEL_GATEWAY_API_KEY: 'gateway-test-key-0123456789',
    MODEL_GATEWAY_ENC_KEY: ENC,
    MODEL_GATEWAY_TIMEOUT_MS: 120_000,
  } as AppConfig;
}

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'provider-1',
    name: 'Mock',
    baseUrl: 'http://upstream.test/v1',
    apiKeyCipher: box.encrypt('upstream-key'),
    headers: null,
    enabled: true,
    priority: 10,
    timeoutMs: 10_000,
    maxTokensField: 'max_tokens',
    note: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function route(overrides: Record<string, unknown> = {}) {
  return {
    id: 'route-1',
    providerId: 'provider-1',
    alias: 'deepseek-v4-pro',
    upstreamModel: 'real-model',
    enabled: true,
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    provider: provider(),
    ...overrides,
  };
}

function makeService(routes: unknown[][]) {
  const findMany = vi.fn();
  for (const rows of routes) findMany.mockResolvedValueOnce(rows);
  const logCreate = vi.fn(async () => ({}));
  const prisma = {
    aiModelRoute: { findMany },
    modelCallLog: { create: logCreate },
  } as never;
  return { service: new ModelGatewayService(config(), prisma, {} as never), findMany, logCreate };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ModelGatewayService.chatCompletion', () => {
  it('routes by alias, rewrites response model, records token usage', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      model: 'real-model',
      choices: [{ message: { role: 'assistant', content: '{"ok":true}' } }],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { service, logCreate } = makeService([[route()]]);

    const result = await service.chatCompletion({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 64,
    });

    expect(result.status).toBe(200);
    expect((result.body as { model: string }).model).toBe('deepseek-v4-pro');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://upstream.test/v1/chat/completions');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'real-model', max_tokens: 64 });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer upstream-key');
    expect(logCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'OK', inputTokens: 12, outputTokens: 5, alias: 'deepseek-v4-pro' }),
    }));
  });

  it('falls back to the default route when the alias is unknown', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'OK' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = makeService([[], [route({ alias: 'unknown-task', upstreamModel: 'default-model', isDefault: true })]]);

    const result = await service.chatCompletion({ model: 'task-model', messages: [{ role: 'user', content: 'ping' }] });

    expect(result.status).toBe(200);
    expect((result.body as { model: string }).model).toBe('task-model');
  });

  it('returns model_not_found when no route or default exists', async () => {
    const { service, logCreate } = makeService([[], []]);
    const result = await service.chatCompletion({ model: 'missing', messages: [{ role: 'user', content: 'ping' }] });
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: { code: 'model_not_found' } });
    expect(logCreate).toHaveBeenCalled();
  });

  it('respects max_completion_tokens provider compatibility', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.max_tokens !== undefined) {
        return new Response(JSON.stringify({ error: { message: 'max_tokens unsupported' } }), { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { service } = makeService([[route({ provider: provider({ maxTokensField: 'max_completion_tokens' }) })]]);

    const result = await service.chatCompletion({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 9,
    });
    expect(result.status).toBe(200);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.max_completion_tokens).toBe(9);
    expect(body.max_tokens).toBeUndefined();
  });
});

describe('ModelGatewayService.probeProvider', () => {
  it('fetches models, filters non-chat models and tests the first chat model', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/models')) {
        return new Response(JSON.stringify({
          data: [{ id: 'text-embedding-3-small' }, { id: 'deepseek-chat' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { service } = makeService([]);

    const result = await service.probeProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
    });

    expect(result).toMatchObject({ ok: true, models: ['deepseek-chat'], testModel: 'deepseek-chat' });
    expect(calls[0]).toBe('https://api.example.com/v1/models');
    expect(calls[1]).toBe('https://api.example.com/v1/chat/completions');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineHttp } from './engine-http.js';

const tenant = { userId: 'u-1', workspaceId: 'w-1', role: 'admin' as const };

function http(): EngineHttp {
  return new EngineHttp(
    { ENGINE_ORIGIN: 'http://engine.test' } as never,
    { mint: async () => 'token' } as never,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EngineHttp 原始响应字节', () => {
  it('CSV 按字节透传,保留 UTF-8 BOM(否则 Excel 中文乱码)', async () => {
    const csv = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('公司名\r\nMuster GmbH\r\n', 'utf8'),
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(csv, {
        status: 200,
        headers: { 'content-type': 'text/csv; charset=utf-8' },
      })),
    );

    const result = await http().call(tenant, 'GET', '/exports/sample');

    expect(Buffer.isBuffer(result.body)).toBe(true);
    expect((result.body as Buffer).subarray(0, 3).toString('hex')).toBe('efbbbf');
  });

  it('JSON 响应仍解析为对象', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })),
    );

    const result = await http().call(tenant, 'GET', '/leads');

    expect(result.body).toEqual({ data: { ok: true } });
  });
});


describe('generation HTTP status and single-attempt transport', () => {
  it('preserves 202 and unresolved generation data without synthesizing success', async () => {
    const body = { data: {
      generationId: '11111111-1111-4111-8111-111111111111',
      companyId: '22222222-2222-4222-8222-222222222222',
      intentId: '33333333-3333-4333-8333-333333333333',
      intentDigest: 'a'.repeat(64), phase: 'RESULT_UNKNOWN', reasonCode: 'RESULT_UNKNOWN',
      preparedAt: '2026-11-21T00:00:00Z', updatedAt: '2026-11-21T00:00:00Z', set: null, execution: null,
    } };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(body), {
      status: 202, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetcher);
    const result = await http().call(tenant, 'POST', '/market-candidate-generations/11111111-1111-4111-8111-111111111111/recover');
    expect(result.status).toBe(202);
    expect(result.body).toEqual(body);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['TimeoutError', 'TypeError'])('does not retry a failed generation wire (%s)', async (name) => {
    const fetcher = vi.fn(async () => { throw Object.assign(new Error('synthetic transport failure'), { name }); });
    vi.stubGlobal('fetch', fetcher);
    await expect(http().call(tenant, 'POST', '/market-candidate-generations/11111111-1111-4111-8111-111111111111/execute', {
      body: { intentDigest: 'a'.repeat(64) }, timeoutMs: 240_000,
    })).rejects.toThrow('synthetic transport failure');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

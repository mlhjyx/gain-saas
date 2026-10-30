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

    const result = await http().call(tenant, 'GET', '/reports/weekly');

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

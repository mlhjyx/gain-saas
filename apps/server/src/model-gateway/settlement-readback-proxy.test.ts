import { describe, expect, it } from 'vitest';
import { registerSettlementReadbackProxy } from './settlement-readback-proxy.js';

type Handler = (req: unknown, res: unknown, next: () => void) => void;

function capture(config: { MODEL_GATEWAY_SETTLEMENT_ORIGIN?: string; MODEL_GATEWAY_API_KEY?: string }): Handler {
  let handler: Handler | undefined;
  registerSettlementReadbackProxy(
    {
      all: (_path: string, h: Handler) => {
        handler = h;
      },
    },
    config as never,
  );
  if (!handler) throw new Error('proxy not registered');
  return handler;
}

function response() {
  const state: { status: number; body: unknown; headers: Record<string, string> } = {
    status: 200,
    body: undefined,
    headers: {},
  };
  const res = {
    setHeader: (key: string, value: string) => {
      state.headers[key] = value;
    },
    status: (code: number) => {
      state.status = code;
      return res;
    },
    json: (body: unknown) => {
      state.body = body;
      return res;
    },
    send: (body: unknown) => {
      state.body = body;
      return res;
    },
    state,
  };
  return res;
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    method: 'GET',
    path: '/api/settlement-readback/v1/capability',
    originalUrl: '/api/settlement-readback/v1/capability',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    body: undefined,
    ...overrides,
  };
}

const ORIGIN = { MODEL_GATEWAY_SETTLEMENT_ORIGIN: 'http://new-api.invalid' };

describe('settlement readback proxy auth', () => {
  it('rejects non-loopback callers without a gateway key', async () => {
    const handler = capture(ORIGIN);
    const res = response();
    await handler(request({ socket: { remoteAddress: '192.168.1.50' } }), res, () => undefined);
    expect(res.state.status).toBe(403);
  });

  it('rejects a wrong gateway key from non-loopback', async () => {
    const handler = capture({ ...ORIGIN, MODEL_GATEWAY_API_KEY: 'unit-test-gateway-key' });
    const res = response();
    await handler(
      request({ socket: { remoteAddress: '192.168.1.50' }, headers: { authorization: 'Bearer wrong-unit-test-key' } }),
      res,
      () => undefined,
    );
    expect(res.state.status).toBe(403);
  });

  it('allows loopback capability requests', async () => {
    const handler = capture(ORIGIN);
    const res = response();
    await handler(request(), res, () => undefined);
    expect(res.state.status).toBe(200);
  });

  it('allows non-loopback callers with the gateway key', async () => {
    const handler = capture({ ...ORIGIN, MODEL_GATEWAY_API_KEY: 'unit-test-gateway-key' });
    const res = response();
    await handler(
      request({ socket: { remoteAddress: '192.168.1.50' }, headers: { authorization: 'Bearer unit-test-gateway-key' } }),
      res,
      () => undefined,
    );
    expect(res.state.status).toBe(200);
  });

  it('rejects forwarded non-loopback callers arriving through a local proxy', async () => {
    const handler = capture(ORIGIN);
    const res = response();
    await handler(request({ headers: { 'x-forwarded-for': '203.0.113.7' } }), res, () => undefined);
    expect(res.state.status).toBe(403);
  });
});

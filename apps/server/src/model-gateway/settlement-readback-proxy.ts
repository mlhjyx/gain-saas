import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../config/configuration.js';

const HOP_BY_HOP = new Set([
  'connection',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'upgrade',
]);

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function bearerToken(req: Request): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function gatewayKeyMatches(req: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const token = Buffer.from(bearerToken(req));
  const expectedBuffer = Buffer.from(expected);
  return token.length === expectedBuffer.length && timingSafeEqual(token, expectedBuffer);
}

/**
 * 只允许本机调用或携带网关 Key 的调用。
 * 该代理会转发调用方凭据到 new-api,绝不能对公网/局域网开放;
 * 若 Future 通过 loopback 反代进入,带非本机 X-Forwarded-For 的请求也拒绝。
 */
function isTrustedCaller(req: Request, expectedGatewayKey: string | undefined): boolean {
  if (gatewayKeyMatches(req, expectedGatewayKey)) return true;
  if (!isLoopback(req.socket.remoteAddress)) return false;
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const hops = forwarded
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (hops.length > 0 && !hops.every(isLoopback)) return false;
  }
  return true;
}

/**
 * 站点构建的 new-api settlement readback 代理。
 * 引擎把 MODEL_GATEWAY_URL 指向本服务后,读回请求仍会打到同一 origin 的
 * /api/settlement-readback/v1/*;这里原样转发到 new-api,避免客户 worker
 * 的启动/心跳检查因缺少该契约而停在 STARTING。
 */
export function registerSettlementReadbackProxy(
  express: { all: (path: string, handler: (req: Request, res: Response, next: NextFunction) => void) => void },
  config: AppConfig,
): void {
  const origin = config.MODEL_GATEWAY_SETTLEMENT_ORIGIN?.replace(/\/+$/, '');
  if (!origin) return;
  express.all('/api/settlement-readback/*path', async (req: Request, res: Response) => {
    if (!isTrustedCaller(req, config.MODEL_GATEWAY_API_KEY)) {
      res.status(403).json({
        error: {
          code: 'SETTLEMENT_READBACK_FORBIDDEN',
          message: 'settlement readback 仅允许本机调用或携带网关 Key 的调用',
        },
      });
      return;
    }
    // 客户 worker 的启动检查只认这个契约;直接本地应答,避免 new-api 短暂不可达拖住整个 worker。
    if (req.method === 'GET' && req.path === '/api/settlement-readback/v1/capability') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-new-api-settlement-contract', 'new-api-settlement-readback/v1');
      res.status(200).send(Buffer.from(JSON.stringify({ schema_version: 'new-api-settlement-readback-capability/v1', status: 'ready' })));
      return;
    }
    const target = `${origin}${req.originalUrl}`;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(key) || key === 'host' || value === undefined) continue;
      headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    let body: string | undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (typeof req.body === 'string') body = req.body;
      else if (req.body && typeof req.body === 'object') body = JSON.stringify(req.body);
    }
    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        if (!HOP_BY_HOP.has(key.toLowerCase())) res.setHeader(key, value);
      });
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.send(buffer);
    } catch (error) {
      res.status(502).json({
        error: {
          code: 'SETTLEMENT_READBACK_PROXY_UNAVAILABLE',
          message: `new-api settlement readback 不可达:${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  });
}

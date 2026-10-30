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

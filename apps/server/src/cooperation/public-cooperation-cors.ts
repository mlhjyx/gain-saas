import expressLib from 'express';
import type { Express, NextFunction, Request, Response } from 'express';

const MAX_BODY_BYTES = 16 * 1024;

/** body-parser 的超限错误统一映射成文档里的 413；其余解析错误按 400 返回。 */
function rejectBody(error: unknown, res: Response): void {
  const status = (error as { status?: number })?.status;
  if (status === 413 || (error as { type?: string })?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: '请求体过大' } });
    return;
  }
  res.status(400).json({ error: { code: 'INVALID_BODY', message: '请求体不是合法 JSON' } });
}

/**
 * 官网公开端点的前置安全层（只作用于 `/api/public/cooperation-intents`）：
 * - CORS：允许官网域名跨域提交；未配置时 `*`（端点无 cookie、无登录态）；
 * - 预检：OPTIONS 204；未授权的 Origin 预检直接 403；
 * - 体积：路径专属 JSON/urlencoded parser，按实际字节数（chunked / gzip 解压后）执行
 *   16KB 上限——Content-Length 只作为解析前的快速拒绝；
 * - 响应头：nosniff + no-store，避免把用户提交内容缓存到代理。
 */
export function registerPublicCooperationCors(app: Express, allowedOrigins: string): void {
  const raw = (allowedOrigins ?? '').trim();
  const allowAll = raw === '' || raw === '*';
  const allowlist = new Set(
    raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const strictJson = expressLib.json({ limit: MAX_BODY_BYTES });
  const strictUrlencoded = expressLib.urlencoded({ extended: false, limit: MAX_BODY_BYTES });

  app.use('/api/public/cooperation-intents', (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');

    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const permitted = origin !== undefined && (allowAll || allowlist.has(origin));
    if (permitted) {
      res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : origin!);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }

    if (req.method === 'OPTIONS') {
      if (origin !== undefined && !permitted) {
        res.status(403).json({ error: { code: 'ORIGIN_NOT_ALLOWED', message: '来源域名不允许' } });
        return;
      }
      res.status(204).end();
      return;
    }

    const length = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: '请求体过大' } });
      return;
    }

    // 真正的体积闸门：按解析出的字节数判定（无 Content-Length / chunked / gzip 也覆盖）。
    strictJson(req, res, (jsonError) => {
      if (jsonError) {
        rejectBody(jsonError, res);
        return;
      }
      strictUrlencoded(req, res, (urlError) => {
        if (urlError) {
          rejectBody(urlError, res);
          return;
        }
        next();
      });
    });
  });
}

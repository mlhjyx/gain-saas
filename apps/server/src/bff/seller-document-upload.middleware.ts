import { copyForError } from '@gain-saas/shared';
import expressLib from 'express';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { SESSION_COOKIE, type SessionService } from '../tenant/session.service.js';

export const SELLER_DOCUMENT_CONTENT_UPLOAD_PATH =
  '/api/companies/:companyId/seller-documents/:documentId/content';

export const SELLER_DOCUMENT_MAX_BYTES = 51 * 1024 * 1024;

export type SessionVerifier = Pick<SessionService, 'verify'>;

function sendUploadError(
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
): void {
  const acceptLanguage =
    typeof req.headers?.['accept-language'] === 'string'
      ? req.headers['accept-language']
      : undefined;
  const copy = copyForError(code, acceptLanguage);
  res.status(status).json({
    error: {
      code,
      userCopy: { title: copy.title, why: copy.why, next: copy.next },
    },
    meta: { engineCode: code, engineMessage: message },
  });
}

export function isSellerDocumentContentUploadPath(path: unknown): boolean {
  if (typeof path !== 'string' || !path.startsWith('/api/')) return false;
  const parts = path.split('/').filter(Boolean);
  return (
    parts.length === 6 &&
    parts[0] === 'api' &&
    parts[1] === 'companies' &&
    parts[2].length > 0 &&
    parts[3] === 'seller-documents' &&
    parts[4].length > 0 &&
    parts[5] === 'content'
  );
}

function isPayloadTooLarge(error: unknown): boolean {
  const record = error as { status?: number; statusCode?: number; type?: string } | null;
  return (
    record?.status === 413 ||
    record?.statusCode === 413 ||
    record?.type === 'entity.too.large'
  );
}

function clientRawBodyErrorStatus(error: unknown): number | null {
  const record = error as { status?: unknown; statusCode?: unknown } | null;
  const status =
    typeof record?.status === 'number'
      ? record.status
      : typeof record?.statusCode === 'number'
        ? record.statusCode
        : null;
  return status !== null && status >= 400 && status < 500 ? status : null;
}

function clientRawBodyErrorCode(status: number, error: unknown): string {
  const type = (error as { type?: unknown } | null)?.type;
  if (status === 415 || type === 'encoding.unsupported' || type === 'charset.unsupported') {
    return 'UNSUPPORTED_CONTENT_ENCODING';
  }
  return 'VALIDATION_ERROR';
}

/**
 * 资料库文件上传前置鉴权与 51MB 二进制体解析（仅作用于 PUT /api/companies/:companyId/seller-documents/:documentId/content）：
 * - 使用与 `bff.module.ts:matchRoute()` 同构的路径分段规范化，消除 `//` 绕过与前缀过度匹配；
 * - 先校验真实 `saas_session` JWT 与 DB 会话未吊销，防止未登录请求触发 51MB 堆内存缓冲 DoS；
 * - 注册在全局 `express.json()` 之前，避免未登录或 `.json` 上传请求进入 JSON parser；
 * - 对超过 51MB 的请求在解析前按 Content-Length 快速拒绝，并将 raw parser 4xx 错误映射为标准 JSON。
 */
export function createSellerDocumentUploadMiddleware(
  sessionService: SessionVerifier,
  rawParser: RequestHandler = expressLib.raw({ type: () => true, limit: '51mb' }),
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.method !== 'PUT' || !isSellerDocumentContentUploadPath(req.path)) {
      next();
      return;
    }

    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || token.length === 0) {
      sendUploadError(req, res, 401, 'AUTH_REQUIRED', '请先登录');
      return;
    }

    let claims: Awaited<ReturnType<SessionVerifier['verify']>> = null;
    try {
      claims = await sessionService.verify(token);
    } catch {
      claims = null;
    }
    if (!claims) {
      res.clearCookie?.(SESSION_COOKIE);
      sendUploadError(req, res, 401, 'AUTH_REQUIRED', '会话已过期,请重新登录');
      return;
    }

    const rawContentLength = req.headers?.['content-length'];
    const contentLength =
      typeof rawContentLength === 'string' && rawContentLength.trim() !== ''
        ? Number(rawContentLength)
        : Number.NaN;
    if (Number.isFinite(contentLength) && contentLength > SELLER_DOCUMENT_MAX_BYTES) {
      sendUploadError(req, res, 413, 'PAYLOAD_TOO_LARGE', '上传文件超过 51MB 限制');
      return;
    }

    rawParser(req, res, (err?: unknown) => {
      if (!err) {
        next();
        return;
      }
      if (isPayloadTooLarge(err)) {
        const message =
          err instanceof Error && err.message ? err.message : '上传文件超过 51MB 限制';
        sendUploadError(req, res, 413, 'PAYLOAD_TOO_LARGE', message);
        return;
      }
      const clientStatus = clientRawBodyErrorStatus(err);
      if (clientStatus !== null) {
        const message =
          err instanceof Error && err.message ? err.message : '上传请求体格式无效';
        sendUploadError(
          req,
          res,
          clientStatus,
          clientRawBodyErrorCode(clientStatus, err),
          message,
        );
        return;
      }
      next(err);
    });
  };
}

export function registerSellerDocumentUploadMiddleware(
  expressInstance: Pick<Express, 'use'>,
  sessionService: SessionVerifier,
): void {
  expressInstance.use(createSellerDocumentUploadMiddleware(sessionService));
}

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import cookieParser from 'cookie-parser';
import expressLib from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  SELLER_DOCUMENT_CONTENT_UPLOAD_PATH,
  SELLER_DOCUMENT_MAX_BYTES,
  createSellerDocumentUploadMiddleware,
  registerSellerDocumentUploadMiddleware,
} from './seller-document-upload.middleware.js';
import { SESSION_COOKIE, type SessionService } from '../tenant/session.service.js';

function mockResponse() {
  const state: { status?: number; body?: unknown; clearedCookies: string[]; clearedCookieOptions: unknown[] } = {
    clearedCookies: [],
    clearedCookieOptions: [],
  };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      return res;
    },
    clearCookie(name: string, options?: unknown) {
      state.clearedCookies.push(name);
      state.clearedCookieOptions.push(options);
      return res;
    },
    state,
  };
  return res;
}

function validClaims() {
  return {
    userId: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    role: 'member' as const,
    jti: 'jti-1',
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

async function withExpressServer(
  sessionService: Pick<SessionService, 'verify'>,
  run: (baseUrl: string, captured: { method?: string; body?: unknown; contentType?: string }) => Promise<void>,
) {
  const app = expressLib();
  app.use(cookieParser());
  registerSellerDocumentUploadMiddleware(app, sessionService);
  app.use(expressLib.json({ limit: '8mb' }));
  app.use(expressLib.urlencoded({ extended: true, limit: '8mb' }));

  const captured: { method?: string; body?: unknown; contentType?: string } = {};
  app.use((req, res) => {
    captured.method = req.method;
    captured.body = req.body;
    captured.contentType = req.get('content-type');
    res.status(200).json({ ok: true, isBuffer: Buffer.isBuffer(req.body) });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, captured);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

const UPLOAD_PATH = '/api/companies/c1/seller-documents/d1/content';

describe('seller-document upload middleware (unit)', () => {
  it('rejects PUT with missing session cookie before invoking raw body parser', async () => {
    const verify = vi.fn();
    const rawParser = vi.fn();
    const next = vi.fn();
    const res = mockResponse();
    const handler = createSellerDocumentUploadMiddleware({ verify }, rawParser);

    await handler(
      { method: 'PUT', path: UPLOAD_PATH, cookies: {}, headers: {} } as never,
      res as never,
      next,
    );

    expect(res.state.status).toBe(401);
    expect(res.state.body).toMatchObject({
      error: {
        code: 'AUTH_REQUIRED',
        userCopy: {
          title: expect.any(String),
          why: expect.any(String),
          next: expect.any(String),
        },
      },
      meta: { engineCode: 'AUTH_REQUIRED' },
    });
    expect(verify).not.toHaveBeenCalled();
    expect(rawParser).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects PUT carrying only legacy gain_session cookie', async () => {
    const verify = vi.fn();
    const rawParser = vi.fn();
    const next = vi.fn();
    const res = mockResponse();
    const handler = createSellerDocumentUploadMiddleware({ verify }, rawParser);

    await handler(
      {
        method: 'PUT',
        path: UPLOAD_PATH,
        cookies: { gain_session: 'forged-legacy-cookie' },
        headers: { 'accept-language': 'en-US' },
      } as never,
      res as never,
      next,
    );

    expect(res.state.status).toBe(401);
    expect(res.state.body).toMatchObject({
      error: {
        code: 'AUTH_REQUIRED',
        userCopy: { title: 'Your session has expired' },
      },
    });
    expect(verify).not.toHaveBeenCalled();
    expect(rawParser).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects PUT with invalid or revoked saas_session cookie, clears cookie with clearCookieOptions, and skips raw parser', async () => {
    const verify = vi.fn(async () => null);
    const clearOpts = { httpOnly: true, sameSite: 'lax' as const, path: '/', secure: true };
    const clearCookieOptions = vi.fn(() => clearOpts);
    const rawParser = vi.fn();
    const next = vi.fn();
    const res = mockResponse();
    const handler = createSellerDocumentUploadMiddleware({ verify, clearCookieOptions }, rawParser);

    await handler(
      {
        method: 'PUT',
        path: UPLOAD_PATH,
        cookies: { [SESSION_COOKIE]: 'revoked-or-forged-jwt' },
        headers: {},
      } as never,
      res as never,
      next,
    );

    expect(verify).toHaveBeenCalledWith('revoked-or-forged-jwt');
    expect(res.state.clearedCookies).toEqual([SESSION_COOKIE]);
    expect(res.state.clearedCookieOptions).toEqual([clearOpts]);
    expect(res.state.status).toBe(401);
    expect(res.state.body).toMatchObject({
      error: { code: 'AUTH_REQUIRED', userCopy: { title: expect.any(String) } },
      meta: { engineCode: 'AUTH_REQUIRED' },
    });
    expect(rawParser).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed with 401 and clears cookie when sessionService.verify throws unexpectedly', async () => {
    const verify = vi.fn(async () => {
      throw new Error('db connection lost');
    });
    const rawParser = vi.fn();
    const next = vi.fn();
    const res = mockResponse();
    const handler = createSellerDocumentUploadMiddleware({ verify }, rawParser);

    await handler(
      {
        method: 'PUT',
        path: UPLOAD_PATH,
        cookies: { [SESSION_COOKIE]: 'some-token' },
        headers: {},
      } as never,
      res as never,
      next,
    );

    expect(res.state.clearedCookies).toEqual([SESSION_COOKIE]);
    expect(res.state.status).toBe(401);
    expect(res.state.body).toMatchObject({
      error: { code: 'AUTH_REQUIRED' },
      meta: { engineCode: 'AUTH_REQUIRED' },
    });
    expect(rawParser).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['GET', 'POST', 'DELETE'] as const)(
    'passes non-PUT (%s) requests through immediately without pre-auth or raw parsing',
    async (method) => {
      const verify = vi.fn();
      const rawParser = vi.fn();
      const next = vi.fn();
      const res = mockResponse();
      const handler = createSellerDocumentUploadMiddleware({ verify }, rawParser);

      await handler({ method, path: UPLOAD_PATH, cookies: {}, headers: {} } as never, res as never, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
      expect(verify).not.toHaveBeenCalled();
      expect(rawParser).not.toHaveBeenCalled();
      expect(res.state.status).toBeUndefined();
    },
  );

  it.each([
    '/api/companies/c1/seller-documents/d1/content/extra',
    '/api/companies/c1/seller-documents/d1/claim-previews',
    '/api/companies/c1/seller-documents/d1/CONTENT',
    '//api/companies/c1/seller-documents/d1/content',
  ])(
    'passes non-matching PUT path (%s) through immediately without pre-auth or raw parsing',
    async (path) => {
      const verify = vi.fn();
      const rawParser = vi.fn();
      const next = vi.fn();
      const res = mockResponse();
      const handler = createSellerDocumentUploadMiddleware({ verify }, rawParser);

      await handler({ method: 'PUT', path, cookies: {}, headers: {} } as never, res as never, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
      expect(verify).not.toHaveBeenCalled();
      expect(rawParser).not.toHaveBeenCalled();
      expect(res.state.status).toBeUndefined();
    },
  );

  it('fast-rejects PUT with Content-Length > 51MB with 413 PAYLOAD_TOO_LARGE before invoking raw parser', async () => {
    const verify = vi.fn(async () => validClaims());
    const rawParser = vi.fn();
    const next = vi.fn();
    const res = mockResponse();
    const handler = createSellerDocumentUploadMiddleware({ verify }, rawParser);

    await handler(
      {
        method: 'PUT',
        path: UPLOAD_PATH,
        cookies: { [SESSION_COOKIE]: 'valid-token' },
        headers: { 'content-length': String(SELLER_DOCUMENT_MAX_BYTES + 1) },
      } as never,
      res as never,
      next,
    );

    expect(verify).toHaveBeenCalledWith('valid-token');
    expect(res.state.status).toBe(413);
    expect(res.state.body).toMatchObject({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        userCopy: { title: expect.any(String), why: expect.any(String), next: expect.any(String) },
      },
      meta: { engineCode: 'PAYLOAD_TOO_LARGE' },
    });
    expect(rawParser).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('maps PayloadTooLargeError from raw parser to structured 413 PAYLOAD_TOO_LARGE JSON', async () => {
    const verify = vi.fn(async () => validClaims());
    const rawParser = vi.fn((_req, _res, cb: (err?: unknown) => void) => {
      const err = Object.assign(new Error('request entity too large'), {
        status: 413,
        type: 'entity.too.large',
      });
      cb(err);
    });
    const next = vi.fn();
    const res = mockResponse();
    const handler = createSellerDocumentUploadMiddleware({ verify }, rawParser);

    await handler(
      {
        method: 'PUT',
        path: UPLOAD_PATH,
        cookies: { [SESSION_COOKIE]: 'valid-token' },
        headers: {},
      } as never,
      res as never,
      next,
    );

    expect(rawParser).toHaveBeenCalledTimes(1);
    expect(res.state.status).toBe(413);
    expect(res.state.body).toMatchObject({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        userCopy: { title: expect.any(String) },
      },
      meta: { engineCode: 'PAYLOAD_TOO_LARGE' },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('maps 400 client error from raw parser to structured 400 JSON instead of calling next(err)', async () => {
    const verify = vi.fn(async () => validClaims());
    const rawParser = vi.fn((_req, _res, cb: (err?: unknown) => void) => {
      const err = Object.assign(new Error('request aborted'), {
        status: 400,
        type: 'request.aborted',
      });
      cb(err);
    });
    const next = vi.fn();
    const res = mockResponse();
    const handler = createSellerDocumentUploadMiddleware({ verify }, rawParser);

    await handler(
      {
        method: 'PUT',
        path: UPLOAD_PATH,
        cookies: { [SESSION_COOKIE]: 'valid-token' },
        headers: {},
      } as never,
      res as never,
      next,
    );

    expect(res.state.status).toBe(400);
    expect(res.state.body).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        userCopy: { title: expect.any(String), why: expect.any(String), next: expect.any(String) },
      },
      meta: { engineCode: 'VALIDATION_ERROR', engineMessage: 'request aborted' },
    });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('seller-document upload middleware + expressLib.json integration', () => {
  const uploadPath = '/api/companies/c1/seller-documents/d1/content';

  it('registers on the seller-document content path', () => {
    expect(SELLER_DOCUMENT_CONTENT_UPLOAD_PATH).toBe(
      '/api/companies/:companyId/seller-documents/:documentId/content',
    );
  });

  it('buffers binary body for authenticated PUT requests', async () => {
    const verify = vi.fn(async (token: string) => (token === 'valid-jwt' ? validClaims() : null));
    const payload = Buffer.from('%PDF-1.4\nhello binary world', 'utf8');

    await withExpressServer({ verify }, async (baseUrl, captured) => {
      const response = await fetch(`${baseUrl}${uploadPath}`, {
        method: 'PUT',
        headers: {
          cookie: `${SESSION_COOKIE}=valid-jwt`,
          'content-type': 'application/pdf',
        },
        body: payload,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, isBuffer: true });
      expect(Buffer.isBuffer(captured.body)).toBe(true);
      expect(Buffer.compare(captured.body as Buffer, payload)).toBe(0);
    });
  });

  it('blocks unauthenticated PUT .../content with Content-Type: application/json before expressLib.json', async () => {
    const verify = vi.fn(async () => null);

    await withExpressServer({ verify }, async (baseUrl, captured) => {
      const response = await fetch(`${baseUrl}${uploadPath}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
        },
        body: '{invalid-json-payload',
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { code: 'AUTH_REQUIRED' },
      });
      expect(captured.method).toBeUndefined();
    });
  });

  it('preserves Buffer req.body for authenticated PUT .../content even when Content-Type is application/json', async () => {
    const verify = vi.fn(async (token: string) => (token === 'valid-jwt' ? validClaims() : null));
    const rawNonJsonBytes = Buffer.from('{not-parsed-as-json', 'utf8');

    await withExpressServer({ verify }, async (baseUrl, captured) => {
      const response = await fetch(`${baseUrl}${uploadPath}`, {
        method: 'PUT',
        headers: {
          cookie: `${SESSION_COOKIE}=valid-jwt`,
          'content-type': 'application/json',
        },
        body: rawNonJsonBytes,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, isBuffer: true });
      expect(Buffer.isBuffer(captured.body)).toBe(true);
      expect(Buffer.compare(captured.body as Buffer, rawNonJsonBytes)).toBe(0);
    });
  });

  it('does not interfere with normal JSON POST routes', async () => {
    const verify = vi.fn();

    await withExpressServer({ verify }, async (baseUrl, captured) => {
      const response = await fetch(`${baseUrl}/api/companies/c1/seller-documents/d1/claim-previews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reference: 'chunk:0', type: 'product', statement: 'ISO 9001' }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, isBuffer: false });
      expect(captured.body).toEqual({ reference: 'chunk:0', type: 'product', statement: 'ISO 9001' });
      expect(verify).not.toHaveBeenCalled();
    });
  });

  it('maps real expressLib.raw PayloadTooLargeError to 413 PAYLOAD_TOO_LARGE JSON over HTTP', async () => {
    const verify = vi.fn(async () => validClaims());
    const app = expressLib();
    app.use(cookieParser());
    app.use(
      createSellerDocumentUploadMiddleware(
        { verify },
        expressLib.raw({ type: () => true, limit: '16b' }),
      ),
    );
    app.use(expressLib.json({ limit: '8mb' }));
    app.use((_req, res) => res.status(200).json({ ok: true }));

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}${uploadPath}`, {
        method: 'PUT',
        headers: {
          cookie: `${SESSION_COOKIE}=valid-jwt`,
          'content-type': 'application/octet-stream',
        },
        body: Buffer.alloc(64, 0x41),
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          userCopy: { title: expect.any(String), why: expect.any(String), next: expect.any(String) },
        },
        meta: { engineCode: 'PAYLOAD_TOO_LARGE' },
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it.each([
    '/api/companies//c1/seller-documents/d1/content',
    '/api//companies/c1/seller-documents/d1/content',
  ])(
    'blocks unauthenticated PUT %s with Content-Type: application/json before expressLib.json',
    async (slashVariantPath) => {
      const verify = vi.fn(async () => null);

      await withExpressServer({ verify }, async (baseUrl, captured) => {
        const response = await fetch(`${baseUrl}${slashVariantPath}`, {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
          },
          body: '{invalid-json-payload',
        });

        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({
          error: { code: 'AUTH_REQUIRED' },
        });
        expect(captured.method).toBeUndefined();
      });
    },
  );

  it.each(['application/octet-stream', 'application/json'])(
    'buffers body into Buffer for authenticated PUT /api/companies//c1/seller-documents/d1/content (%s)',
    async (contentType) => {
      const verify = vi.fn(async (token: string) => (token === 'valid-jwt' ? validClaims() : null));
      const payload = Buffer.from('{"hello":"world-binary"}', 'utf8');

      await withExpressServer({ verify }, async (baseUrl, captured) => {
        const response = await fetch(`${baseUrl}/api/companies//c1/seller-documents/d1/content`, {
          method: 'PUT',
          headers: {
            cookie: `${SESSION_COOKIE}=valid-jwt`,
            'content-type': contentType,
          },
          body: payload,
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, isBuffer: true });
        expect(Buffer.isBuffer(captured.body)).toBe(true);
        expect(Buffer.compare(captured.body as Buffer, payload)).toBe(0);
      });
    },
  );

  it('bypasses upload middleware for PUT /api/companies/c1/seller-documents/d1/content/extra', async () => {
    const verify = vi.fn(async () => validClaims());

    await withExpressServer({ verify }, async (baseUrl, captured) => {
      const response = await fetch(`${baseUrl}/api/companies/c1/seller-documents/d1/content/extra`, {
        method: 'PUT',
        headers: {
          cookie: `${SESSION_COOKIE}=valid-jwt`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ok: true }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, isBuffer: false });
      expect(captured.body).toEqual({ ok: true });
      expect(verify).not.toHaveBeenCalled();
    });
  });

  it('maps real expressLib.raw 415 encoding.unsupported to structured 415 JSON over HTTP', async () => {
    const verify = vi.fn(async () => validClaims());

    await withExpressServer({ verify }, async (baseUrl, captured) => {
      const response = await fetch(`${baseUrl}${uploadPath}`, {
        method: 'PUT',
        headers: {
          cookie: `${SESSION_COOKIE}=valid-jwt`,
          'content-type': 'application/octet-stream',
          'content-encoding': 'bogus-enc',
        },
        body: Buffer.from('hello'),
      });

      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({
        error: {
          code: 'UNSUPPORTED_CONTENT_ENCODING',
          userCopy: { title: expect.any(String), why: expect.any(String), next: expect.any(String) },
        },
        meta: { engineCode: 'UNSUPPORTED_CONTENT_ENCODING' },
      });
      expect(captured.method).toBeUndefined();
    });
  });
});

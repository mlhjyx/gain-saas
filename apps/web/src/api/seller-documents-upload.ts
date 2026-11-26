/**
 * 卖家资料分片上传与解析进度客户端（PR-OB1）。
 *
 * - 对齐 BFF 透传合同（PR #234 / #236）：
 *   1) POST /api/companies/:companyId/seller-documents/presign
 *   2) POST /api/companies/:companyId/seller-documents/:documentId/multipart/init
 *   3) PUT  /api/companies/:companyId/seller-documents/:documentId/parts/:partNumber?uploadId=...
 *   4) POST /api/companies/:companyId/seller-documents/:documentId/multipart/complete
 *   5) PUT  /api/companies/:companyId/seller-documents/:documentId/content（<= partSizeBytes 直传）
 *   6) POST /api/companies/:companyId/seller-documents/:documentId/commit
 *   7) GET  /api/seller-documents/:documentId（读取 parsedMeta）
 *   8) POST /api/seller-documents/:documentId/retry
 * - 二进制上传统一走 XMLHttpRequest，支持实时字节进度、速率估算、withCredentials 与主动 abort。
 * - 不直接触发全局 toast，由上层上传队列与界面按三层白话文案呈现并支持自动重试与续传。
 */
import type { components } from '@gain-saas/engine-client';

import { useAppConfig } from '@vben/hooks';
import { preferences } from '@vben/preferences';
import { useAccessStore } from '@vben/stores';

/** S3/MinIO 协议分片下限默认值：5 MiB。实际值优先取 presign/init 返回的 partSizeBytes。 */
export const DEFAULT_PART_SIZE_BYTES = 5 * 1024 * 1024;
/** 大画册温和提示阈值：30 MiB。 */
export const LARGE_PDF_HINT_BYTES = 30 * 1024 * 1024;
/** 二进制文档（PDF/Office）单文件上限：50 MiB。 */
export const MAX_BINARY_FILE_BYTES = 50 * 1024 * 1024;
/** 纯文本/Markdown 单文件上限：10 MiB。 */
export const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024;

export type PresignSellerDocumentInput = components['schemas']['PresignSellerDocumentDto'];
export type MultipartCompletedPart = components['schemas']['MultipartCompletedPartDto'];
export type UploadSellerDocumentPartResponse = components['schemas']['UploadSellerDocumentPartResponseDto'];
export type InitSellerDocumentMultipartResponse = components['schemas']['InitSellerDocumentMultipartResponseDto'];

export interface PresignSellerDocumentResult {
  directUploadSupported: boolean;
  documentId: string;
  expiresAt: string;
  partSizeBytes: number;
  uploadMode?: 'direct' | 'multipart';
  uploadUrl: string;
}

export interface SellerDocumentParsedMeta {
  aiClaimsCount?: number | null;
  aiProductsCount?: number | null;
  fullParsePending?: boolean;
  mode?: 'full' | 'priority_pages' | string;
  parsedPages?: number | null;
  totalPages?: number | null;
  tailParsePartial?: boolean;
  visionUsed?: boolean;
  [key: string]: unknown;
}

export interface SellerDocumentProgressItem {
  chunkCount?: number;
  createdAt?: string;
  filename: string;
  id: string;
  mime?: string;
  parsedMeta?: SellerDocumentParsedMeta | null;
  processingErrorCode?: string | null;
  sizeBytes?: number | string;
  status: string;
}

export interface UploadProgressEvent {
  loaded: number;
  total: number;
}

export interface UploadPartOptions {
  blob: Blob;
  companyId: string;
  documentId: string;
  onAbortRegister?: (abort: () => void) => void;
  onProgress?: (progress: UploadProgressEvent) => void;
  partNumber: number;
  uploadId: string;
}

export interface UploadDirectOptions {
  companyId: string;
  documentId: string;
  file: Blob;
  mime: string;
  onAbortRegister?: (abort: () => void) => void;
  onProgress?: (progress: UploadProgressEvent) => void;
}

export class UploadApiError extends Error {
  readonly code?: string;
  readonly isAborted: boolean;
  readonly isNetwork: boolean;
  readonly next?: string;
  readonly status?: number;
  readonly title?: string;
  readonly why?: string;

  constructor(
    message: string,
    options: {
      code?: string;
      isAborted?: boolean;
      isNetwork?: boolean;
      next?: string;
      status?: number;
      title?: string;
      why?: string;
    } = {},
  ) {
    super(message);
    this.name = 'UploadApiError';
    this.status = options.status;
    this.code = options.code;
    this.title = options.title;
    this.why = options.why;
    this.next = options.next;
    this.isNetwork = Boolean(options.isNetwork);
    this.isAborted = Boolean(options.isAborted);
  }
}

export const SELLER_DOC_MIME_BY_EXT: Record<string, string> = {
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  md: 'text/markdown',
  pdf: 'application/pdf',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const ALLOWED_MIMES = new Set(Object.values(SELLER_DOC_MIME_BY_EXT));
const TEXT_MIMES = new Set(['text/markdown', 'text/plain']);

export function detectDocumentMime(file: Pick<File, 'name' | 'type'>): string | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (ext && ext in SELLER_DOC_MIME_BY_EXT) {
    return SELLER_DOC_MIME_BY_EXT[ext] ?? null;
  }
  if (file.type && ALLOWED_MIMES.has(file.type)) {
    return file.type;
  }
  return null;
}

export type FileValidationResult =
  | { code: 'FILE_TOO_LARGE' | 'TEXT_TOO_LARGE' | 'UNSUPPORTED_TYPE'; ok: false }
  | { largePdfHint: boolean; mime: string; ok: true };

export function validateSellerDocumentFile(file: Pick<File, 'name' | 'size' | 'type'>): FileValidationResult {
  const mime = detectDocumentMime(file);
  if (!mime) {
    return { code: 'UNSUPPORTED_TYPE', ok: false };
  }
  if (TEXT_MIMES.has(mime)) {
    if (file.size > MAX_TEXT_FILE_BYTES) {
      return { code: 'TEXT_TOO_LARGE', ok: false };
    }
    return { largePdfHint: false, mime, ok: true };
  }
  if (file.size > MAX_BINARY_FILE_BYTES) {
    return { code: 'FILE_TOO_LARGE', ok: false };
  }
  return {
    largePdfHint: mime === 'application/pdf' && file.size > LARGE_PDF_HINT_BYTES,
    mime,
    ok: true,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${Math.round(bytes)} B`;
}

export function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '—';
  if (bytesPerSec >= 1024 * 1024) {
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  return `${Math.max(1, Math.round(bytesPerSec / 1024))} KB/s`;
}

export function normalizeParsedMeta(raw: unknown): SellerDocumentParsedMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const num = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    ...obj,
    aiClaimsCount: num(obj.aiClaimsCount),
    aiProductsCount: num(obj.aiProductsCount),
    fullParsePending: typeof obj.fullParsePending === 'boolean' ? obj.fullParsePending : undefined,
    mode: typeof obj.mode === 'string' ? obj.mode : undefined,
    parsedPages: num(obj.parsedPages),
    totalPages: num(obj.totalPages),
    tailParsePartial: obj.tailParsePartial === true,
    visionUsed: typeof obj.visionUsed === 'boolean' ? obj.visionUsed : undefined,
  };
}

/** 复用项目既有 baseURL 约定，兼容 VITE_GLOB_API_URL=/api 与静态构建前缀。 */
export function resolveUploadApiBase(): string {
  try {
    const { apiURL } = useAppConfig(import.meta.env, import.meta.env.PROD);
    if (typeof apiURL === 'string' && apiURL.trim().length > 0) {
      return apiURL.replace(/\/$/, '');
    }
  } catch {
    // 非应用挂载上下文（例如 Vitest 单测）回退到环境变量或 /api
  }
  const envUrl = (import.meta.env?.VITE_GLOB_API_URL as string | undefined) ?? '';
  return (envUrl.trim() || '/api').replace(/\/$/, '');
}

function buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  try {
    if (preferences?.app?.locale) {
      headers['Accept-Language'] = preferences.app.locale;
    }
  } catch {
    // ignore in unit tests
  }
  try {
    const token = useAccessStore()?.accessToken;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  } catch {
    // ignore in unit tests
  }
  return headers;
}

function unwrapEnvelope<T>(payload: unknown): T {
  if (payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

function parseErrorPayload(status: number, rawBody: unknown): UploadApiError {
  const body = (rawBody && typeof rawBody === 'object' ? rawBody : null) as {
    error?: {
      code?: string;
      message?: string;
      userCopy?: { next?: string; title?: string; why?: string };
    };
    message?: string;
  } | null;
  const err = body?.error;
  const userCopy = err?.userCopy;
  const message = userCopy?.title ?? err?.message ?? body?.message ?? `HTTP ${status}`;
  return new UploadApiError(message, {
    code: err?.code,
    next: userCopy?.next,
    status,
    title: userCopy?.title,
    why: userCopy?.why,
  });
}

async function fetchJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = `${resolveUploadApiBase()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      credentials: 'include',
      headers: buildHeaders({
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      }),
    });
  } catch (err) {
    throw new UploadApiError(err instanceof Error ? err.message : 'Network error', {
      isNetwork: true,
    });
  }
  const text = await response.text().catch(() => '');
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    throw parseErrorPayload(response.status, parsed);
  }
  if (parsed && typeof parsed === 'object' && 'error' in (parsed as Record<string, unknown>)) {
    throw parseErrorPayload(response.status, parsed);
  }
  return unwrapEnvelope<T>(parsed);
}

function sendBinaryWithXhr<T>(params: {
  body: Blob;
  contentType: string;
  onAbortRegister?: (abort: () => void) => void;
  onProgress?: (progress: UploadProgressEvent) => void;
  parseJsonResponse: boolean;
  url: string;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', params.url, true);
    xhr.withCredentials = true;

    const headers = buildHeaders({ 'Content-Type': params.contentType });
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }

    if (xhr.upload && params.onProgress) {
      xhr.upload.onprogress = (event: ProgressEvent) => {
        const total = event.lengthComputable && event.total > 0 ? event.total : params.body.size;
        params.onProgress?.({ loaded: Math.min(event.loaded, total), total });
      };
    }

    xhr.onload = () => {
      let parsed: unknown = null;
      if (xhr.responseText) {
        try {
          parsed = JSON.parse(xhr.responseText);
        } catch {
          parsed = null;
        }
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        params.onProgress?.({ loaded: params.body.size, total: params.body.size });
        if (!params.parseJsonResponse) {
          resolve(unwrapEnvelope<T>(parsed));
          return;
        }
        resolve(unwrapEnvelope<T>(parsed));
        return;
      }
      reject(parseErrorPayload(xhr.status, parsed));
    };

    xhr.onerror = () => {
      reject(new UploadApiError('Network error during upload', { isNetwork: true }));
    };

    xhr.ontimeout = () => {
      reject(new UploadApiError('Upload timed out', { isNetwork: true }));
    };

    xhr.onabort = () => {
      reject(new UploadApiError('Upload aborted', { isAborted: true }));
    };

    params.onAbortRegister?.(() => {
      try {
        xhr.abort();
      } catch {
        // ignore abort errors on already-settled XHR
      }
    });

    xhr.send(params.body);
  });
}

export interface SellerDocumentsUploadApi {
  commit(companyId: string, documentId: string): Promise<SellerDocumentProgressItem>;
  completeMultipart(
    companyId: string,
    documentId: string,
    payload: { parts: MultipartCompletedPart[]; uploadId: string },
  ): Promise<SellerDocumentProgressItem>;
  fetchDocument(documentId: string): Promise<SellerDocumentProgressItem>;
  initMultipart(companyId: string, documentId: string): Promise<InitSellerDocumentMultipartResponse>;
  presign(companyId: string, input: PresignSellerDocumentInput): Promise<PresignSellerDocumentResult>;
  retryProcessing(documentId: string): Promise<SellerDocumentProgressItem>;
  uploadDirectContent(options: UploadDirectOptions): Promise<SellerDocumentProgressItem | undefined>;
  uploadPart(options: UploadPartOptions): Promise<UploadSellerDocumentPartResponse>;
}

export const sellerDocumentsUploadApi: SellerDocumentsUploadApi = {
  async presign(companyId, input) {
    const raw = await fetchJson<components['schemas']['PresignSellerDocumentResponseDto']>(
      `/companies/${encodeURIComponent(companyId)}/seller-documents/presign`,
      {
        body: JSON.stringify(input),
        method: 'POST',
      },
    );
    const partSizeBytes =
      typeof raw.partSizeBytes === 'number' && Number.isFinite(raw.partSizeBytes) && raw.partSizeBytes > 0
        ? raw.partSizeBytes
        : DEFAULT_PART_SIZE_BYTES;
    return {
      directUploadSupported: Boolean(raw.directUploadSupported),
      documentId: raw.documentId,
      expiresAt: raw.expiresAt,
      partSizeBytes,
      uploadMode: raw.uploadMode,
      uploadUrl: raw.uploadUrl,
    };
  },

  async initMultipart(companyId, documentId) {
    const raw = await fetchJson<InitSellerDocumentMultipartResponse>(
      `/companies/${encodeURIComponent(companyId)}/seller-documents/${encodeURIComponent(documentId)}/multipart/init`,
      {
        body: JSON.stringify({}),
        method: 'POST',
      },
    );
    return {
      documentId: raw.documentId || documentId,
      partSizeBytes:
        typeof raw.partSizeBytes === 'number' && raw.partSizeBytes > 0
          ? raw.partSizeBytes
          : DEFAULT_PART_SIZE_BYTES,
      uploadId: raw.uploadId,
    };
  },

  async uploadPart(options) {
    const base = resolveUploadApiBase();
    const url = `${base}/companies/${encodeURIComponent(options.companyId)}/seller-documents/${encodeURIComponent(options.documentId)}/parts/${options.partNumber}?uploadId=${encodeURIComponent(options.uploadId)}`;
    const raw = await sendBinaryWithXhr<UploadSellerDocumentPartResponse>({
      body: options.blob,
      contentType: 'application/octet-stream',
      onAbortRegister: options.onAbortRegister,
      onProgress: options.onProgress,
      parseJsonResponse: true,
      url,
    });
    return {
      etag: raw.etag,
      partNumber: raw.partNumber ?? options.partNumber,
    };
  },

  async completeMultipart(companyId, documentId, payload) {
    return await fetchJson<SellerDocumentProgressItem>(
      `/companies/${encodeURIComponent(companyId)}/seller-documents/${encodeURIComponent(documentId)}/multipart/complete`,
      {
        body: JSON.stringify(payload),
        method: 'POST',
      },
    );
  },

  async uploadDirectContent(options) {
    const base = resolveUploadApiBase();
    const url = `${base}/companies/${encodeURIComponent(options.companyId)}/seller-documents/${encodeURIComponent(options.documentId)}/content`;
    return await sendBinaryWithXhr<SellerDocumentProgressItem | undefined>({
      body: options.file,
      contentType: options.mime,
      onAbortRegister: options.onAbortRegister,
      onProgress: options.onProgress,
      parseJsonResponse: false,
      url,
    });
  },

  async commit(companyId, documentId) {
    return await fetchJson<SellerDocumentProgressItem>(
      `/companies/${encodeURIComponent(companyId)}/seller-documents/${encodeURIComponent(documentId)}/commit`,
      {
        body: JSON.stringify({}),
        method: 'POST',
      },
    );
  },

  fetchDocument(documentId) {
    return fetchJson<SellerDocumentProgressItem>(
      `/seller-documents/${encodeURIComponent(documentId)}`,
    );
  },

  retryProcessing(documentId) {
    return fetchJson<SellerDocumentProgressItem>(
      `/seller-documents/${encodeURIComponent(documentId)}/retry`,
      { body: JSON.stringify({}), method: 'POST' },
    );
  },
};

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

import {
  DEFAULT_PART_SIZE_BYTES,
  LARGE_PDF_HINT_BYTES,
  MAX_BINARY_FILE_BYTES,
  type PresignSellerDocumentInput,
  type PresignSellerDocumentResult,
  UploadApiError,
  type SellerDocumentsUploadApi,
} from '#/api/seller-documents-upload';
import { useUploadQueueStore } from '../upload-queue';

function makeFakeFile(name: string, sizeBytes: number, type = 'application/pdf'): File {
  const file = new File(['%PDF-1.4\n'], name, { type });
  Object.defineProperty(file, 'size', { configurable: true, value: sizeBytes });
  // happy-dom File.slice 依赖内部字节长度；重写 slice 返回声明长度的 Blob 以便精准断言分片边界
  file.slice = ((start = 0, end = sizeBytes, contentType = 'application/octet-stream') => {
    const safeStart = Math.max(0, Math.min(start, sizeBytes));
    const safeEnd = Math.max(safeStart, Math.min(end, sizeBytes));
    const blob = new Blob(['x'], { type: contentType });
    Object.defineProperty(blob, 'size', { configurable: true, value: safeEnd - safeStart });
    return blob;
  }) as File['slice'];
  return file;
}

async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

function createMockApi(overrides: Partial<SellerDocumentsUploadApi> = {}): SellerDocumentsUploadApi {
  return {
    commit: vi.fn(async (_companyId, documentId) => ({
      filename: 'brochure.pdf',
      id: documentId,
      status: 'queued',
    })),
    completeMultipart: vi.fn(async (_companyId, documentId) => ({
      filename: 'brochure.pdf',
      id: documentId,
      status: 'pending_upload',
    })),
    fetchDocument: vi.fn(async (id) => ({ filename: 'brochure.pdf', id, status: 'queued' })),
    initMultipart: vi.fn(async (_companyId, documentId) => ({
      documentId,
      partSizeBytes: DEFAULT_PART_SIZE_BYTES,
      uploadId: 'up-1',
    })),
    presign: vi.fn(async (_companyId: string, input: PresignSellerDocumentInput): Promise<PresignSellerDocumentResult> => ({
      directUploadSupported: false,
      documentId: 'doc-1',
      expiresAt: '2026-11-27T02:00:00.000Z',
      partSizeBytes: DEFAULT_PART_SIZE_BYTES,
      uploadMode: input.size > DEFAULT_PART_SIZE_BYTES ? 'multipart' : 'direct',
      uploadUrl: 'https://storage.local/staging/doc-1',
    })),
    retryProcessing: vi.fn(async (id) => ({ filename: 'brochure.pdf', id, status: 'queued' })),
    uploadDirectContent: vi.fn(async ({ file, onProgress }) => {
      onProgress?.({ loaded: file.size, total: file.size });
      return undefined;
    }),
    uploadPart: vi.fn(async ({ blob, onProgress, partNumber }) => {
      onProgress?.({ loaded: blob.size, total: blob.size });
      return { etag: `"etag-${partNumber}"`, partNumber };
    }),
    ...overrides,
  };
}

describe('useUploadQueueStore (PR-OB1)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    const store = useUploadQueueStore();
    store.reset();
    vi.restoreAllMocks();
  });

  it('clears the queue and cancels transfers when Vben resets the stores at sign-out', async () => {
    let finishUpload!: () => void;
    const abort = vi.fn(() => finishUpload());
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const api = createMockApi({
      uploadDirectContent: vi.fn(({ onAbortRegister }) =>
        new Promise<undefined>((resolve) => {
          finishUpload = () => resolve(undefined);
          onAbortRegister?.(abort);
        }),
      ),
    });
    const store = useUploadQueueStore();
    store.configureRuntime({ api });
    store.enqueueFiles('c1', [makeFakeFile('brochure.pdf', 1024)]);
    await flushMicrotasks();

    store.$reset();
    await flushMicrotasks();

    expect(abort).toHaveBeenCalledOnce();
    expect(store.items).toHaveLength(0);
    expect(removeListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    expect(api.commit).not.toHaveBeenCalled();
  });

  it('uses the returned part size for small files even when the storage URL is private', async () => {
    const partSizeBytes = 8 * 1024 * 1024;
    const api = createMockApi({
      presign: vi.fn(async () => ({
        directUploadSupported: false,
        documentId: 'doc-1',
        expiresAt: '2026-11-27T02:00:00.000Z',
        partSizeBytes,
        uploadMode: 'multipart' as const,
        uploadUrl: 'https://storage.local/staging/doc-1',
      })),
    });
    const store = useUploadQueueStore();
    store.configureRuntime({ api });
    store.enqueueFiles('c1', [makeFakeFile('brochure.pdf', partSizeBytes)]);
    await flushMicrotasks(30);

    expect(api.uploadDirectContent).toHaveBeenCalledOnce();
    expect(api.initMultipart).not.toHaveBeenCalled();
  });

  it('retries commit without resending completed parts after an interrupted confirmation', async () => {
    const api = createMockApi({
      commit: vi.fn()
        .mockRejectedValueOnce(new UploadApiError('Network error', { isNetwork: true }))
        .mockResolvedValueOnce({ filename: 'brochure.pdf', id: 'doc-1', status: 'queued' }),
    });
    const store = useUploadQueueStore();
    store.configureRuntime({ api, retryDelaysMs: [] });
    store.enqueueFiles('c1', [makeFakeFile('brochure.pdf', DEFAULT_PART_SIZE_BYTES + 1)]);
    await flushMicrotasks(30);
    expect(store.items[0]?.status).toBe('interrupted');

    store.resumeTask(store.items[0]!.id);
    await flushMicrotasks(30);

    expect(api.uploadPart).toHaveBeenCalledTimes(2);
    expect(api.completeMultipart).toHaveBeenCalledOnce();
    expect(api.commit).toHaveBeenCalledTimes(2);
    expect(store.items[0]?.status).toBe('parsing_priority');
  });

  it('can confirm a staged document when multipart completion succeeded but its response was lost', async () => {
    let staged = false;
    const api = createMockApi({
      completeMultipart: vi.fn(async () => {
        staged = true;
        throw new UploadApiError('Completion response unavailable', { status: 503 });
      }),
      commit: vi.fn(async (_companyId, documentId) => {
        if (!staged) throw new UploadApiError('Content not staged', { status: 409 });
        return { filename: 'brochure.pdf', id: documentId, status: 'queued' };
      }),
    });
    const store = useUploadQueueStore();
    store.configureRuntime({ api, retryDelaysMs: [] });
    store.enqueueFiles('c1', [makeFakeFile('brochure.pdf', DEFAULT_PART_SIZE_BYTES + 1)]);
    await flushMicrotasks(30);

    expect(api.completeMultipart).toHaveBeenCalledOnce();
    expect(api.commit).toHaveBeenCalledOnce();
    expect(store.items[0]?.status).toBe('parsing_priority');
  });

  it('polls an uploaded file by ID and retries failed processing on the original document', async () => {
    const api = createMockApi({
      fetchDocument: vi.fn(async (id) => ({
        filename: 'brochure.pdf',
        id,
        processingErrorCode: 'PROCESSING_FAILED',
        status: 'failed_terminal',
      })),
    });
    const store = useUploadQueueStore();
    store.configureRuntime({ api, priorityPollMs: 60_000 });
    store.enqueueFiles('c1', [makeFakeFile('brochure.pdf', DEFAULT_PART_SIZE_BYTES + 1)]);
    await flushMicrotasks(30);
    await store.pollOnce();

    expect(api.fetchDocument).toHaveBeenCalledWith('doc-1');
    expect(store.items[0]?.status).toBe('failed');

    store.retryTask(store.items[0]!.id);
    await flushMicrotasks(30);

    expect(api.retryProcessing).toHaveBeenCalledWith('doc-1');
    expect(api.presign).toHaveBeenCalledOnce();
    expect(api.completeMultipart).toHaveBeenCalledOnce();
    expect(store.items[0]?.status).toBe('parsing_priority');
  });

  it('reflects a queued server retry separately from active parsing', async () => {
    const api = createMockApi({
      fetchDocument: vi.fn(async (id) => ({
        filename: 'catalog.pdf',
        id,
        status: 'processing',
      })),
    });
    const store = useUploadQueueStore();
    store.configureRuntime({ api, priorityPollMs: 60_000 });
    store.restoreProcessing('c1', [{
      filename: 'catalog.pdf',
      id: 'doc-1',
      processingErrorCode: 'DOCUMENT_PARSE_UNAVAILABLE',
      status: 'queued',
    }]);
    expect(store.items[0]?.parseQueueState).toBe('retrying');
    expect(store.items[0]?.status).toBe('parsing_priority');

    await store.pollOnce();
    expect(store.items[0]?.parseQueueState).toBeNull();
    expect(api.presign).not.toHaveBeenCalled();
    expect(api.retryProcessing).not.toHaveBeenCalled();
  });

  it('resumes polling committed documents after a reload without restarting an upload', async () => {
    const api = createMockApi({
      fetchDocument: vi.fn(async (id) => ({
        filename: 'catalog.pdf',
        id,
        parsedMeta: { fullParsePending: false, mode: 'full', parsedPages: 48, totalPages: 48 },
        status: 'ready',
      })),
    });
    const store = useUploadQueueStore();
    store.configureRuntime({ api, fullPollMs: 60_000 });

    const previousDocuments = [
      {
        filename: 'catalog.pdf',
        id: 'doc-1',
        parsedMeta: { fullParsePending: true, mode: 'priority_pages', parsedPages: 15, totalPages: 48 },
        status: 'ready',
      },
      { filename: 'abandoned.pdf', id: 'doc-2', status: 'pending_upload' },
      { filename: 'finished.pdf', id: 'doc-3', status: 'ready' },
    ];
    store.restoreProcessing('c1', previousDocuments);
    store.restoreProcessing('c1', previousDocuments);

    expect(store.items.map((item) => [item.documentId, item.status])).toEqual([
      ['doc-1', 'priority_ready'],
    ]);
    expect(store.assetVersion).toBe(0);

    await store.pollOnce();
    expect(store.items[0]?.status).toBe('ready');
    expect(store.lastAssetUpdate?.phase).toBe('ready');
    expect(api.presign).not.toHaveBeenCalled();
  });

  it('refreshes late product extraction counts for a bounded period after a document becomes readable', async () => {
    let reads = 0;
    const api = createMockApi({
      fetchDocument: vi.fn(async (id) => ({
        filename: 'catalog.pdf',
        id,
        parsedMeta: { aiProductsCount: reads++ ? 3 : 0, fullParsePending: false, mode: 'full' },
        status: 'ready',
      })),
    });
    const store = useUploadQueueStore();
    store.configureRuntime({ api, fullPollMs: 60_000 });
    store.enqueueFiles('c1', [makeFakeFile('catalog.pdf', 1024)]);
    await flushMicrotasks(20);
    await store.pollOnce();
    expect(store.items[0]?.status).toBe('ready');
    await store.pollOnce();
    expect(store.lastAssetUpdate?.aiProductsCount).toBe(3);
    for (let index = 0; index < 5; index++) await store.pollOnce();
    expect(api.fetchDocument).toHaveBeenCalledTimes(4);
  });

  it('严格按 presign.partSizeBytes（5 MiB）边界分流：<= 5 MiB 走直传，> 5 MiB 走分片上传', async () => {
    const api = createMockApi();
    const store = useUploadQueueStore();
    store.configureRuntime({ api, fullPollMs: 60_000, priorityPollMs: 60_000, retryDelaysMs: [0, 0, 0] });

    // 1) 恰好等于 5 MiB 且 uploadMode='direct' -> 直传 PUT .../content
    const exact5Mb = makeFakeFile('small-5mb.pdf', DEFAULT_PART_SIZE_BYTES);
    store.enqueueFiles('c1', [exact5Mb]);
    await flushMicrotasks();

    expect(api.presign).toHaveBeenCalledTimes(1);
    expect(api.uploadDirectContent).toHaveBeenCalledTimes(1);
    expect(api.initMultipart).not.toHaveBeenCalled();
    expect(api.uploadPart).not.toHaveBeenCalled();
    expect(api.commit).toHaveBeenCalledWith('c1', 'doc-1');
    expect(store.items[0]?.uploadMode).toBe('direct');
    expect(store.items[0]?.status).toBe('parsing_priority');

    // 2) 超过 5 MiB（12 MiB）-> 切 3 片（5 MiB + 5 MiB + 2 MiB）走 multipart 流程
    vi.mocked(api.presign).mockResolvedValueOnce({
      directUploadSupported: false,
      documentId: 'doc-2',
      expiresAt: '2026-11-27T02:00:00.000Z',
      partSizeBytes: DEFAULT_PART_SIZE_BYTES,
      uploadMode: 'multipart',
      uploadUrl: 'https://storage.local/staging/doc-2',
    });
    const twelveMb = makeFakeFile('catalog-12mb.pdf', 12 * 1024 * 1024);
    store.enqueueFiles('c1', [twelveMb]);
    await flushMicrotasks(20);

    expect(api.initMultipart).toHaveBeenCalledWith('c1', 'doc-2');
    expect(api.uploadPart).toHaveBeenCalledTimes(3);
    const partSizes = vi.mocked(api.uploadPart).mock.calls.map((call) => ({
      partNumber: call[0].partNumber,
      size: call[0].blob.size,
    }));
    expect(partSizes).toEqual([
      { partNumber: 1, size: DEFAULT_PART_SIZE_BYTES },
      { partNumber: 2, size: DEFAULT_PART_SIZE_BYTES },
      { partNumber: 3, size: 2 * 1024 * 1024 },
    ]);
    expect(api.completeMultipart).toHaveBeenCalledWith('c1', 'doc-2', {
      parts: [
        { etag: '"etag-1"', partNumber: 1 },
        { etag: '"etag-2"', partNumber: 2 },
        { etag: '"etag-3"', partNumber: 3 },
      ],
      uploadId: 'up-1',
    });
    expect(api.commit).toHaveBeenCalledWith('c1', 'doc-2');
  });

  it('分片失败自动退避重试 3 次，耗尽后保留已完成 etag 进入 interrupted，点击续传跳过已完成分片', async () => {
    let part2Attempts = 0;
    const uploadedPartsLog: number[] = [];

    const api = createMockApi({
      uploadPart: vi.fn(async ({ blob, onProgress, partNumber }) => {
        uploadedPartsLog.push(partNumber);
        if (partNumber === 2) {
          part2Attempts += 1;
          // 首次上传期间第 2 片连续失败 4 次（初次 + 3 次重试），触发 interrupted
          if (part2Attempts <= 4) {
            throw new UploadApiError('Connection reset', { isNetwork: true });
          }
        }
        onProgress?.({ loaded: blob.size, total: blob.size });
        return { etag: `"etag-${partNumber}"`, partNumber };
      }),
    });

    const store = useUploadQueueStore();
    store.configureRuntime({ api, fullPollMs: 60_000, priorityPollMs: 60_000, retryDelaysMs: [0, 0, 0] });

    // 11 MiB -> 3 片
    const file = makeFakeFile('heavy-11mb.pdf', 11 * 1024 * 1024);
    const { accepted } = store.enqueueFiles('c1', [file]);
    const taskId = accepted[0]!.id;
    await flushMicrotasks(30);

    const task = store.items.find((item) => item.id === taskId)!;
    expect(task.status).toBe('interrupted');
    expect(task.documentId).toBe('doc-1');
    expect(task.uploadId).toBe('up-1');
    expect(task.completedParts).toEqual([{ etag: '"etag-1"', partNumber: 1 }]);
    expect(part2Attempts).toBe(4); // 初次 + 3 次退避重试

    // 点击「断点续传」：不得重新 presign / initMultipart，且跳过第 1 片，仅上传第 2、3 片
    uploadedPartsLog.length = 0;
    store.resumeTask(taskId);
    await flushMicrotasks(30);

    expect(api.presign).toHaveBeenCalledTimes(1);
    expect(api.initMultipart).toHaveBeenCalledTimes(1);
    expect(uploadedPartsLog).toEqual([2, 3]);
    expect(api.completeMultipart).toHaveBeenCalledWith('c1', 'doc-1', {
      parts: [
        { etag: '"etag-1"', partNumber: 1 },
        { etag: '"etag-2"', partNumber: 2 },
        { etag: '"etag-3"', partNumber: 3 },
      ],
      uploadId: 'up-1',
    });
    expect(task.status).toBe('parsing_priority');
  });

  it('本地校验：>30MB 标记 largePdfHint 仍允许上传；>50MB 与非法格式本地拦截不发网络请求', async () => {
    const api = createMockApi();
    const store = useUploadQueueStore();
    store.configureRuntime({ api, fullPollMs: 60_000, priorityPollMs: 60_000, retryDelaysMs: [0] });

    const huge = makeFakeFile('print-52mb.pdf', MAX_BINARY_FILE_BYTES + 2 * 1024 * 1024);
    const badExt = makeFakeFile('archive.zip', 1024, 'application/zip');
    const largeOk = makeFakeFile('brochure-38mb.pdf', LARGE_PDF_HINT_BYTES + 8 * 1024 * 1024);

    const res = store.enqueueFiles('c1', [huge, badExt, largeOk]);
    expect(res.rejected).toEqual([
      { code: 'FILE_TOO_LARGE', filename: 'print-52mb.pdf', sizeBytes: huge.size },
      { code: 'UNSUPPORTED_TYPE', filename: 'archive.zip', sizeBytes: 1024 },
    ]);
    expect(res.accepted).toHaveLength(1);
    expect(res.accepted[0]?.largePdfHint).toBe(true);
    expect(res.largePdfFiles).toEqual([{ filename: 'brochure-38mb.pdf', sizeBytes: largeOk.size }]);

    await flushMicrotasks(20);
    // 只有合法的 38MB 画册发起了 presign
    expect(api.presign).toHaveBeenCalledTimes(1);
    expect(api.presign).toHaveBeenCalledWith('c1', {
      filename: 'brochure-38mb.pdf',
      mime: 'application/pdf',
      size: largeOk.size,
    });
  });

  it('parsedMeta 从 priority_pages（15/48 页）演进到 full，自动递增 assetVersion 并同步 visionUsed/计数', async () => {
    let pollRound = 0;
    const api = createMockApi({
      fetchDocument: vi.fn(async (id) => {
        pollRound += 1;
        const full = pollRound > 1;
        return {
          filename: 'catalog.pdf',
          id,
          parsedMeta: {
            aiClaimsCount: full ? 14 : 9,
            aiProductsCount: full ? 9 : 6,
            fullParsePending: !full,
            mode: full ? 'full' : 'priority_pages',
            parsedPages: full ? 48 : 15,
            totalPages: 48,
            visionUsed: true,
          },
          status: 'ready',
        };
      }),
    });

    const store = useUploadQueueStore();
    store.configureRuntime({ api, fullPollMs: 60_000, priorityPollMs: 60_000, retryDelaysMs: [0] });

    const small = makeFakeFile('catalog.pdf', 1024 * 1024);
    store.enqueueFiles('c1', [small]);
    await flushMicrotasks(15);

    expect(store.items[0]?.status).toBe('parsing_priority');
    expect(store.assetVersion).toBe(0);

    // 第 1 轮轮询：前 15 页优先解析就绪
    await store.pollOnce();
    expect(store.items[0]?.status).toBe('priority_ready');
    expect(store.items[0]?.aiProductsCount).toBe(6);
    expect(store.items[0]?.aiClaimsCount).toBe(9);
    expect(store.items[0]?.visionUsed).toBe(true);
    expect(store.assetVersion).toBe(1);
    expect(store.lastAssetUpdate?.phase).toBe('priority_ready');

    // 第 2 轮轮询：全部 48 页全量完成
    await store.pollOnce();
    expect(store.items[0]?.status).toBe('ready');
    expect(store.items[0]?.aiProductsCount).toBe(9);
    expect(store.items[0]?.aiClaimsCount).toBe(14);
    expect(store.assetVersion).toBe(2);
    expect(store.lastAssetUpdate?.phase).toBe('ready');
  });

  it('beforeunload 守卫精准开关：仅在 uploading/committing 时注册，进入服务端解析后立即释放', async () => {
    let finishUpload!: () => void;
    const uploadHold = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });

    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const api = createMockApi({
      uploadDirectContent: vi.fn(async () => {
        await uploadHold;
        return undefined;
      }),
    });

    const store = useUploadQueueStore();
    store.configureRuntime({ api, fullPollMs: 60_000, priorityPollMs: 60_000, retryDelaysMs: [0] });

    const file = makeFakeFile('spec.pdf', 512 * 1024);
    store.enqueueFiles('c1', [file]);
    await flushMicrotasks(10);

    expect(store.items[0]?.status).toBe('uploading');
    expect(store.hasBlockingTransfers).toBe(true);
    expect(addSpy.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true);

    // 上传完毕并 commit 后进入 parsing_priority：服务端已接管，立刻释放 beforeunload
    finishUpload();
    await flushMicrotasks(15);

    expect(store.items[0]?.status).toBe('parsing_priority');
    expect(store.hasBlockingTransfers).toBe(false);
    expect(removeSpy.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true);
  });
});

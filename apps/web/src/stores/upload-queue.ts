/**
 * 全局卖家资料分片上传与前 15 页优先解析队列（PR-OB1）。
 *
 * - 挂载为 Pinia 根单例，路由切换不断流；
 * - 严格读取 presign 返回的 partSizeBytes（默认 5 MiB），大于阈值或 uploadMode='multipart' 走分片续传，否则走直传；
 * - 每片支持 3 次指数退避自动重试；暂停或网络中断完整保留 { documentId, uploadId, completedParts }，续传直接跳过已完成分片；
 * - commit 后按资料 ID 轮询解析进度，同一会话的标签页会在新内容就绪时刷新；
 * - 仅在 uploading / committing 时挂接 beforeunload 守卫，进入云端解析后立刻释放。
 */
import { computed, ref, watch } from 'vue';

import { defineStore } from 'pinia';

import {
  DEFAULT_PART_SIZE_BYTES,
  normalizeParsedMeta,
  sellerDocumentsUploadApi,
  UploadApiError,
  validateSellerDocumentFile,
  type MultipartCompletedPart,
  type SellerDocumentParsedMeta,
  type SellerDocumentProgressItem,
  type SellerDocumentsUploadApi,
} from '#/api/seller-documents-upload';

export type UploadTaskStatus =
  | 'cancelled'
  | 'committing'
  | 'failed'
  | 'interrupted'
  | 'parsing_priority'
  | 'paused'
  | 'priority_ready'
  | 'queued'
  | 'ready'
  | 'uploading';

export type UploadErrorKind =
  | 'FILE_TOO_LARGE'
  | 'GENERIC'
  | 'NETWORK'
  | 'PARSE_FAILED'
  | 'TEXT_TOO_LARGE'
  | 'UNSUPPORTED_TYPE';

export interface UploadQueueItem {
  aiClaimsCount: number;
  aiProductsCount: number;
  companyId: string;
  companyName?: string;
  completedParts: MultipartCompletedPart[];
  contentUploaded: boolean;
  createdAt: number;
  currentPartNumber: number;
  documentId: string | null;
  errorKind: UploadErrorKind | null;
  errorNext: string | null;
  errorTech: string | null;
  errorTitle: string | null;
  file: File | null;
  followUpPolls: number;
  filename: string;
  id: string;
  largePdfHint: boolean;
  parseQueueState: 'retrying' | 'waiting' | null;
  mime: string;
  parsedMeta: SellerDocumentParsedMeta | null;
  partSizeBytes: number;
  percent: number;
  sizeBytes: number;
  speedBytesPerSec: number;
  status: UploadTaskStatus;
  totalParts: number;
  updatedAt: number;
  uploadedBytes: number;
  uploadId: string | null;
  uploadMode: 'direct' | 'multipart';
  visionUsed: boolean;
}

export interface RejectedUploadFile {
  code: 'FILE_TOO_LARGE' | 'TEXT_TOO_LARGE' | 'UNSUPPORTED_TYPE';
  filename: string;
  sizeBytes: number;
}

export interface EnqueueFilesResult {
  accepted: UploadQueueItem[];
  largePdfFiles: Array<{ filename: string; sizeBytes: number }>;
  rejected: RejectedUploadFile[];
  sessionChanged?: boolean;
  skippedCount: number;
}

export interface AssetUpdateEvent {
  aiClaimsCount: number;
  aiProductsCount: number;
  companyId: string;
  documentId: string;
  filename: string;
  phase: 'priority_ready' | 'ready';
  timestamp: number;
  visionUsed: boolean;
}

export interface UploadQueueRuntimeConfig {
  api?: SellerDocumentsUploadApi;
  fullPollMs?: number;
  maxConcurrentUploads?: number;
  priorityPollMs?: number;
  retryDelaysMs?: number[];
}

export const MAX_BATCH_FILES = 5;
export const ASSETS_BROADCAST_CHANNEL = 'gainos-assets';

const DEFAULT_RETRY_DELAYS_MS = [1000, 3000, 6000];
const DEFAULT_PRIORITY_POLL_MS = 3_000;
const DEFAULT_FULL_POLL_MS = 10_000;
const COMPLETED_REFRESH_POLLS = 3;
const DEFAULT_MAX_CONCURRENT_UPLOADS = 2;

let nextTaskSeq = 1;

function createTaskId(): string {
  nextTaskSeq += 1;
  return `uq-${Date.now().toString(36)}-${nextTaskSeq.toString(36)}`;
}

function createQueueItem(
  companyId: string,
  metadata: Pick<UploadQueueItem, 'filename' | 'mime' | 'sizeBytes'>,
  companyName?: string,
): UploadQueueItem {
  const now = Date.now();
  return {
    ...metadata,
    aiClaimsCount: 0,
    aiProductsCount: 0,
    companyId,
    companyName,
    completedParts: [],
    contentUploaded: false,
    createdAt: now,
    currentPartNumber: 0,
    documentId: null,
    errorKind: null,
    errorNext: null,
    errorTech: null,
    errorTitle: null,
    file: null,
    followUpPolls: 0,
    id: createTaskId(),
    largePdfHint: false,
    parseQueueState: null,
    parsedMeta: null,
    partSizeBytes: DEFAULT_PART_SIZE_BYTES,
    percent: 0,
    speedBytesPerSec: 0,
    status: 'queued',
    totalParts: 1,
    updatedAt: now,
    uploadedBytes: 0,
    uploadId: null,
    uploadMode: 'direct',
    visionUsed: false,
  };
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof UploadApiError) {
    if (err.isAborted) return false;
    if (err.isNetwork) return true;
    if (err.status === undefined) return true;
    if (err.status === 408 || err.status === 429 || err.status >= 500) return true;
    return false;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeParts(parts: MultipartCompletedPart[]): MultipartCompletedPart[] {
  const byNumber = new Map<number, MultipartCompletedPart>();
  for (const part of parts) {
    byNumber.set(part.partNumber, { etag: part.etag, partNumber: part.partNumber });
  }
  return [...byNumber.values()].sort((a, b) => a.partNumber - b.partNumber);
}

function computeCompletedBytes(
  parts: MultipartCompletedPart[],
  partSizeBytes: number,
  totalSizeBytes: number,
): number {
  let bytes = 0;
  for (const part of parts) {
    const start = (part.partNumber - 1) * partSizeBytes;
    if (start >= totalSizeBytes) continue;
    const end = Math.min(totalSizeBytes, start + partSizeBytes);
    bytes += Math.max(0, end - start);
  }
  return Math.min(bytes, totalSizeBytes);
}

export const useUploadQueueStore = defineStore('gainos-upload-queue', () => {
  const items = ref<UploadQueueItem[]>([]);
  const trayCollapsed = ref(false);
  const trayDismissed = ref(false);
  const assetVersion = ref(0);
  const lastAssetUpdate = ref<AssetUpdateEvent | null>(null);
  const sessionInvalidated = ref(false);

  let api: SellerDocumentsUploadApi = sellerDocumentsUploadApi;
  let retryDelaysMs: number[] = [...DEFAULT_RETRY_DELAYS_MS];
  let priorityPollMs = DEFAULT_PRIORITY_POLL_MS;
  let fullPollMs = DEFAULT_FULL_POLL_MS;
  let maxConcurrentUploads = DEFAULT_MAX_CONCURRENT_UPLOADS;

  const activeWorkers = new Set<string>();
  const abortControllers = new Map<string, () => void>();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let activePoll: symbol | null = null;
  let beforeUnloadBound = false;
  let channel: BroadcastChannel | null = null;
  let sessionScope: string | null = null;

  const hasBlockingTransfers = computed(() =>
    items.value.some((item) => item.status === 'uploading' || item.status === 'committing'),
  );

  const hasServerParsing = computed(() =>
    items.value.some((item) => item.status === 'parsing_priority' || item.status === 'priority_ready'),
  );

  const hasActiveTasks = computed(() =>
    items.value.some((item) =>
      ['committing', 'parsing_priority', 'priority_ready', 'queued', 'uploading'].includes(item.status),
    ),
  );

  const attentionCount = computed(
    () =>
      items.value.filter((item) =>
        item.status === 'failed' || item.status === 'interrupted' || item.status === 'paused',
      ).length,
  );

  const completedCount = computed(
    () => items.value.filter((item) => item.status === 'ready').length,
  );

  function handleBeforeUnload(event: BeforeUnloadEvent): string {
    event.preventDefault();
    event.returnValue = '';
    return '';
  }

  function syncBeforeUnloadGuard(shouldBlock: boolean): void {
    if (typeof window === 'undefined') return;
    if (shouldBlock && !beforeUnloadBound) {
      window.addEventListener('beforeunload', handleBeforeUnload);
      beforeUnloadBound = true;
    } else if (!shouldBlock && beforeUnloadBound) {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      beforeUnloadBound = false;
    }
  }

  watch(hasBlockingTransfers, (blocking) => {
    syncBeforeUnloadGuard(blocking);
  }, { immediate: true });

  function ensureBroadcastChannel(): BroadcastChannel | null {
    if (channel) return channel;
    if (!sessionScope || typeof BroadcastChannel === 'undefined') return null;
    try {
      channel = new BroadcastChannel(`${ASSETS_BROADCAST_CHANNEL}:${sessionScope}`);
      channel.onmessage = (event: MessageEvent) => {
        const payload = event.data as { payload?: AssetUpdateEvent; type?: string } | null;
        if (payload?.type !== 'company-assets-updated' || !payload.payload) return;
        lastAssetUpdate.value = payload.payload;
        assetVersion.value += 1;
      };
    } catch {
      channel = null;
    }
    return channel;
  }

  function emitAssetUpdate(event: AssetUpdateEvent): void {
    lastAssetUpdate.value = event;
    assetVersion.value += 1;
    const bc = ensureBroadcastChannel();
    if (bc) {
      try {
        bc.postMessage({ payload: event, type: 'company-assets-updated' });
      } catch {
        // 忽略个别受限上下文里的 BroadcastChannel 异常
      }
    }
  }

  function findItem(taskId: string): UploadQueueItem | undefined {
    return items.value.find((item) => item.id === taskId);
  }

  function touch(item: UploadQueueItem): void {
    item.updatedAt = Date.now();
  }

  function applyError(item: UploadQueueItem, err: unknown, fallbackKind: UploadErrorKind): void {
    if (err instanceof UploadApiError) {
      item.errorKind = err.isNetwork ? 'NETWORK' : fallbackKind;
      item.errorTitle = err.title ?? null;
      item.errorNext = err.next ?? null;
      item.errorTech = [err.status ? `HTTP ${err.status}` : '', err.code ?? '', err.message]
        .filter(Boolean)
        .join(' · ');
      return;
    }
    item.errorKind = fallbackKind;
    item.errorTitle = null;
    item.errorNext = null;
    item.errorTech = err instanceof Error ? err.message : String(err);
  }

  function clearError(item: UploadQueueItem): void {
    item.errorKind = null;
    item.errorTitle = null;
    item.errorNext = null;
    item.errorTech = null;
  }

  function pumpQueue(): void {
    if (activeWorkers.size >= maxConcurrentUploads) return;
    const next = items.value.find(
      (item) => item.status === 'queued' && !activeWorkers.has(item.id),
    );
    if (!next) return;
    activeWorkers.add(next.id);
    void processTask(next.id).finally(() => {
      activeWorkers.delete(next.id);
      abortControllers.delete(next.id);
      pumpQueue();
      schedulePolling();
    });
    if (activeWorkers.size < maxConcurrentUploads) {
      pumpQueue();
    }
  }

  async function runWithRetries<T>(
    taskId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      const current = findItem(taskId);
      if (!current || current.status === 'paused' || current.status === 'cancelled') {
        throw new UploadApiError('Upload interrupted by user', { isAborted: true });
      }
      try {
        return await fn();
      } catch (err) {
        const after = findItem(taskId);
        if (!after || after.status === 'paused' || after.status === 'cancelled') {
          throw new UploadApiError('Upload interrupted by user', { isAborted: true });
        }
        if (err instanceof UploadApiError && err.isAborted) {
          throw err;
        }
        if (!isRetryableError(err) || attempt >= retryDelaysMs.length) {
          throw err;
        }
        const delay = retryDelaysMs[attempt] ?? 0;
        attempt += 1;
        await sleep(delay);
      }
    }
  }

  async function processTask(taskId: string): Promise<void> {
    const item = findItem(taskId);
    if (!item || item.status !== 'queued' || !item.file) return;
    const file = item.file;

    item.status = 'uploading';
    clearError(item);
    touch(item);

    let lastSpeedSampleAt = Date.now();
    let lastSpeedSampleBytes = item.uploadedBytes;
    const updateProgress = (uploadedBytes: number) => {
      const current = findItem(taskId);
      if (!current || current.status !== 'uploading') return;
      const clamped = Math.max(0, Math.min(uploadedBytes, current.sizeBytes));
      current.uploadedBytes = clamped;
      current.percent =
        current.sizeBytes > 0 ? Math.min(99, Math.round((clamped / current.sizeBytes) * 100)) : 99;
      const now = Date.now();
      const dt = now - lastSpeedSampleAt;
      if (dt >= 200) {
        const delta = Math.max(0, clamped - lastSpeedSampleBytes);
        const instantSpeed = (delta / dt) * 1000;
        current.speedBytesPerSec =
          current.speedBytesPerSec > 0
            ? Math.round(current.speedBytesPerSec * 0.65 + instantSpeed * 0.35)
            : Math.round(instantSpeed);
        lastSpeedSampleAt = now;
        lastSpeedSampleBytes = clamped;
      }
      touch(current);
    };

    try {
      let committed: SellerDocumentProgressItem | undefined;
      // 1) presign（若断点续传已拿到 documentId 则跳过）
      if (!item.documentId) {
        const signed = await runWithRetries(taskId, () =>
          api.presign(item.companyId, {
            filename: item.filename,
            mime: item.mime,
            size: item.sizeBytes,
          }),
        );
        if (!findItem(taskId) || item.status !== 'uploading') return;
        item.documentId = signed.documentId;
        item.partSizeBytes = signed.partSizeBytes || DEFAULT_PART_SIZE_BYTES;
        const useMultipart = item.sizeBytes > item.partSizeBytes;
        item.uploadMode = useMultipart ? 'multipart' : 'direct';
        item.totalParts = useMultipart
          ? Math.max(1, Math.ceil(item.sizeBytes / item.partSizeBytes))
          : 1;
        touch(item);
      }

      if (!item.contentUploaded && item.uploadMode === 'multipart') {
        // 2) 初始化分片会话（断点续传已有 uploadId 时直接复用）
        if (!item.uploadId) {
          const initialized = await runWithRetries(taskId, () =>
            api.initMultipart(item.companyId, item.documentId!),
          );
          if (!findItem(taskId) || item.status !== 'uploading') return;
          item.uploadId = initialized.uploadId;
          if (initialized.partSizeBytes > 0) {
            item.partSizeBytes = initialized.partSizeBytes;
          }
          item.totalParts = Math.max(1, Math.ceil(item.sizeBytes / item.partSizeBytes));
          touch(item);
        }

        // 3) 逐片上传，自动跳过 completedParts
        const completedSet = new Set(item.completedParts.map((part) => part.partNumber));
        const baseCompleted = computeCompletedBytes(
          item.completedParts,
          item.partSizeBytes,
          item.sizeBytes,
        );
        updateProgress(baseCompleted);

        for (let partNumber = 1; partNumber <= item.totalParts; partNumber += 1) {
          if (completedSet.has(partNumber)) continue;
          if (!findItem(taskId) || item.status !== 'uploading') return;

          const start = (partNumber - 1) * item.partSizeBytes;
          const end = Math.min(item.sizeBytes, start + item.partSizeBytes);
          const blob = file.slice(start, end);
          const completedBeforePart = computeCompletedBytes(
            item.completedParts,
            item.partSizeBytes,
            item.sizeBytes,
          );
          item.currentPartNumber = partNumber;
          touch(item);

          const uploaded = await runWithRetries(taskId, () =>
            api.uploadPart({
              blob,
              companyId: item.companyId,
              documentId: item.documentId!,
              onAbortRegister: (abort) => {
                abortControllers.set(taskId, abort);
              },
              onProgress: ({ loaded }) => {
                updateProgress(completedBeforePart + loaded);
              },
              partNumber,
              uploadId: item.uploadId!,
            }),
          );
          abortControllers.delete(taskId);
          if (!findItem(taskId) || item.status !== 'uploading') return;

          item.completedParts = normalizeParts([
            ...item.completedParts,
            { etag: uploaded.etag, partNumber: uploaded.partNumber },
          ]);
          completedSet.add(uploaded.partNumber);
          updateProgress(
            computeCompletedBytes(item.completedParts, item.partSizeBytes, item.sizeBytes),
          );
        }

        // 4) 合并分片并 commit
        item.status = 'committing';
        item.percent = 100;
        item.uploadedBytes = item.sizeBytes;
        item.speedBytesPerSec = 0;
        touch(item);

        try {
          await runWithRetries(taskId, () =>
            api.completeMultipart(item.companyId, item.documentId!, {
              parts: normalizeParts(item.completedParts),
              uploadId: item.uploadId!,
            }),
          );
        } catch (completionError) {
          if (!isRetryableError(completionError)) throw completionError;
          // 回包丢失时合并可能已成功。让 commit 校验暂存内容，成功就无需再次合并。
          try {
            committed = await runWithRetries(taskId, () => api.commit(item.companyId, item.documentId!));
          } catch (confirmationError) {
            if (confirmationError instanceof UploadApiError &&
              confirmationError.code === 'SELLER_DOCUMENT_UPLOAD_INCOMPLETE') {
              throw completionError;
            }
            throw confirmationError;
          }
        }
      } else if (!item.contentUploaded) {
        // 小文件直传（<= partSizeBytes 且非 multipart）
        item.currentPartNumber = 1;
        item.totalParts = 1;
        await runWithRetries(taskId, () =>
          api.uploadDirectContent({
            companyId: item.companyId,
            documentId: item.documentId!,
            file,
            mime: item.mime,
            onAbortRegister: (abort) => {
              abortControllers.set(taskId, abort);
            },
            onProgress: ({ loaded }) => {
              updateProgress(loaded);
            },
          }),
        );
        abortControllers.delete(taskId);
        if (!findItem(taskId) || item.status !== 'uploading') return;
      }

      // 5) 统一 commit，进入前 15 页优先解析轮询（此时释放 beforeunload 守卫）
      item.contentUploaded = true;
      item.status = 'committing';
      item.percent = 100;
      item.uploadedBytes = item.sizeBytes;
      item.speedBytesPerSec = 0;
      touch(item);
      committed ??= await runWithRetries(taskId, () =>
        api.commit(item.companyId, item.documentId!),
      );
      const current = findItem(taskId);
      if (!current || current.status === 'cancelled') return;

      item.status = 'parsing_priority';
      item.file = null;
      item.percent = 100;
      item.speedBytesPerSec = 0;
      touch(item);
      if (committed) {
        applyRemoteDocumentState(item, committed);
      }
      schedulePolling(true);
    } catch (err) {
      abortControllers.delete(taskId);
      const current = findItem(taskId);
      if (!current) return;
      if (current.status === 'paused' || current.status === 'cancelled') {
        current.speedBytesPerSec = 0;
        touch(current);
        return;
      }
      if (err instanceof UploadApiError && err.isAborted) {
        current.speedBytesPerSec = 0;
        touch(current);
        return;
      }
      current.speedBytesPerSec = 0;
      // 分片/上传中遇到网络或暂时性错误 → 转 interrupted，保留 documentId/uploadId/completedParts 支持断点续传
      if (isRetryableError(err) && (current.status === 'uploading' || current.uploadId || current.contentUploaded)) {
        current.status = 'interrupted';
        applyError(current, err, 'NETWORK');
      } else {
        current.status = 'failed';
        applyError(current, err, 'GENERIC');
      }
      touch(current);
    }
  }

  function applyRemoteDocumentState(
    item: UploadQueueItem,
    remote: SellerDocumentProgressItem,
    announce = true,
  ): void {
    const prevStatus = item.status;
    const prevProducts = item.aiProductsCount;
    const prevClaims = item.aiClaimsCount;
    item.parseQueueState = remote.status === 'queued'
      ? (remote.processingErrorCode ? 'retrying' : 'waiting')
      : null;

    const meta = normalizeParsedMeta(remote.parsedMeta);
    if (meta) {
      item.parsedMeta = meta;
      if (typeof meta.aiProductsCount === 'number') {
        item.aiProductsCount = meta.aiProductsCount;
      }
      if (typeof meta.aiClaimsCount === 'number') {
        item.aiClaimsCount = meta.aiClaimsCount;
      }
      if (typeof meta.visionUsed === 'boolean') {
        item.visionUsed = meta.visionUsed;
      }
    }

    if (remote.status === 'failed_terminal' || remote.status === 'rejected') {
      item.status = 'failed';
      item.errorKind = 'PARSE_FAILED';
      item.errorTitle = null;
      item.errorNext = null;
      item.errorTech = remote.processingErrorCode ?? remote.status;
      touch(item);
      return;
    }

    const isPriorityPartial =
      meta?.mode === 'priority_pages' || meta?.fullParsePending === true;

    if (isPriorityPartial) {
      item.status = 'priority_ready';
    } else if (remote.status === 'ready' || meta?.mode === 'full') {
      item.status = 'ready';
    } else if (['committing', 'processing', 'queued'].includes(remote.status)) {
      if (item.status !== 'priority_ready') {
        item.status = 'parsing_priority';
      }
    }
    touch(item);

    const becameReadyOrPriority =
      (item.status === 'priority_ready' && prevStatus !== 'priority_ready') ||
      (item.status === 'ready' && prevStatus !== 'ready');
    const countsIncreased =
      item.aiProductsCount > prevProducts || item.aiClaimsCount > prevClaims;
    if (item.status === 'ready' && prevStatus !== 'ready') {
      item.followUpPolls = COMPLETED_REFRESH_POLLS;
    }

    if (
      announce && (item.status === 'priority_ready' || item.status === 'ready') &&
      (becameReadyOrPriority || countsIncreased)
    ) {
      emitAssetUpdate({
        aiClaimsCount: item.aiClaimsCount,
        aiProductsCount: item.aiProductsCount,
        companyId: item.companyId,
        documentId: item.documentId ?? remote.id,
        filename: item.filename,
        phase: item.status,
        timestamp: Date.now(),
        visionUsed: item.visionUsed,
      });
    }
  }

  function restoreProcessing(
    companyId: string,
    documents: SellerDocumentProgressItem[],
    companyName?: string,
  ): void {
    if (sessionInvalidated.value) return;
    let restored = false;
    for (const document of documents) {
      const meta = document.parsedMeta;
      const stillParsing = ['queued', 'processing'].includes(document.status) ||
        (document.status === 'ready' && (meta?.mode === 'priority_pages' || meta?.fullParsePending === true));
      if (!stillParsing || items.value.some((item) => item.documentId === document.id)) continue;
      const sizeBytes = Number(document.sizeBytes ?? 0);
      const item = createQueueItem(companyId, {
        filename: document.filename,
        mime: document.mime ?? '',
        sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
      }, companyName);
      item.contentUploaded = true;
      item.documentId = document.id;
      item.percent = 100;
      item.uploadedBytes = item.sizeBytes;
      item.status = 'parsing_priority';
      // 回显读取到的状态，只在后续解析推进时发出刷新事件。
      applyRemoteDocumentState(item, document, false);
      items.value.push(item);
      restored = true;
    }
    if (restored) {
      trayDismissed.value = false;
      schedulePolling();
    }
  }

  async function pollOnce(): Promise<void> {
    if (activePoll) return;
    const targets = items.value.filter(
      (item) =>
        item.documentId &&
        (item.status === 'parsing_priority' || needsFullRefresh(item)),
    );
    if (targets.length === 0) {
      clearPollTimer();
      return;
    }

    const poll = Symbol();
    activePoll = poll;
    try {
      for (const item of targets) {
        if (activePoll !== poll) break;
        const documentId = item.documentId;
        if (!documentId || findItem(item.id) !== item) continue;
        if (item.status === 'ready') item.followUpPolls -= 1;
        try {
          const remote = await api.fetchDocument(documentId);
          if (findItem(item.id) === item && item.documentId === documentId) {
            applyRemoteDocumentState(item, remote);
          }
        } catch {
          // 短暂网络故障在下一轮继续查询。
        }
      }
    } finally {
      if (activePoll === poll) {
        activePoll = null;
        schedulePolling();
      }
    }
  }

  function clearPollTimer(): void {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function needsFullRefresh(item: UploadQueueItem): boolean {
    return item.status === 'priority_ready' || (item.status === 'ready' && item.followUpPolls > 0);
  }

  function schedulePolling(immediate = false): void {
    clearPollTimer();
    const hasPriorityWaiting = items.value.some(
      (item) => item.documentId && item.status === 'parsing_priority',
    );
    const hasFullPending = items.value.some((item) => item.documentId && needsFullRefresh(item));
    if (!hasPriorityWaiting && !hasFullPending) return;

    const delay = immediate
      ? Math.min(priorityPollMs, 50)
      : hasPriorityWaiting
        ? priorityPollMs
        : fullPollMs;

    pollTimer = setTimeout(() => {
      pollTimer = null;
      void pollOnce();
    }, delay);
  }

  function enqueueFiles(
    companyId: string,
    rawFiles: File[] | FileList,
    options: { companyName?: string } = {},
  ): EnqueueFilesResult {
    if (sessionInvalidated.value) {
      return { accepted: [], largePdfFiles: [], rejected: [], sessionChanged: true, skippedCount: 0 };
    }
    ensureBroadcastChannel();
    const list = Array.from(rawFiles);
    const limited = list.slice(0, MAX_BATCH_FILES);
    const skippedCount = Math.max(0, list.length - MAX_BATCH_FILES);

    const accepted: UploadQueueItem[] = [];
    const rejected: RejectedUploadFile[] = [];
    const largePdfFiles: Array<{ filename: string; sizeBytes: number }> = [];

    for (const file of limited) {
      const check = validateSellerDocumentFile(file);
      if (!check.ok) {
        rejected.push({
          code: check.code,
          filename: file.name,
          sizeBytes: file.size,
        });
        continue;
      }

      if (check.largePdfHint) {
        largePdfFiles.push({ filename: file.name, sizeBytes: file.size });
      }

      const task = createQueueItem(companyId, {
        filename: file.name,
        mime: check.mime,
        sizeBytes: file.size,
      }, options.companyName);
      Object.assign(task, {
        file,
        largePdfHint: check.largePdfHint,
        totalParts: Math.max(1, Math.ceil(file.size / DEFAULT_PART_SIZE_BYTES)),
      });
      items.value.unshift(task);
      accepted.push(task);
    }

    if (accepted.length > 0) {
      trayDismissed.value = false;
      pumpQueue();
    }

    return { accepted, largePdfFiles, rejected, skippedCount };
  }

  function pauseTask(taskId: string): void {
    const item = findItem(taskId);
    if (!item) return;
    if (item.status !== 'uploading' && item.status !== 'queued') return;
    item.status = 'paused';
    item.speedBytesPerSec = 0;
    touch(item);
    abortControllers.get(taskId)?.();
    abortControllers.delete(taskId);
  }

  function resumeTask(taskId: string): void {
    const item = findItem(taskId);
    if (!item) return;
    if (item.status !== 'paused' && item.status !== 'interrupted') return;
    clearError(item);
    item.status = 'queued';
    trayDismissed.value = false;
    touch(item);
    pumpQueue();
  }

  async function retryTask(taskId: string): Promise<void> {
    const item = findItem(taskId);
    if (!item) return;
    if (!['cancelled', 'failed', 'interrupted', 'paused'].includes(item.status)) return;

    if (item.errorKind === 'PARSE_FAILED' && item.documentId) {
      const documentId = item.documentId;
      clearError(item);
      trayDismissed.value = false;
      item.status = 'parsing_priority';
      item.parsedMeta = null;
      touch(item);
      try {
        const remote = await api.retryProcessing(documentId);
        if (findItem(taskId) === item) {
          applyRemoteDocumentState(item, remote);
          schedulePolling(true);
        }
      } catch (err) {
        if (findItem(taskId) === item) {
          item.status = 'failed';
          applyError(item, err, 'PARSE_FAILED');
          item.errorKind = 'PARSE_FAILED';
          touch(item);
        }
      }
      return;
    }

    clearError(item);
    if (item.status === 'cancelled' || (!item.contentUploaded && !item.uploadId)) {
      item.documentId = null;
      item.uploadId = null;
      item.completedParts = [];
      item.contentUploaded = false;
      item.uploadedBytes = 0;
      item.percent = 0;
      item.currentPartNumber = 0;
    }
    item.status = 'queued';
    trayDismissed.value = false;
    touch(item);
    pumpQueue();
  }

  function cancelTask(taskId: string): void {
    const item = findItem(taskId);
    if (!item) return;
    item.status = 'cancelled';
    item.speedBytesPerSec = 0;
    touch(item);
    abortControllers.get(taskId)?.();
    abortControllers.delete(taskId);
    schedulePolling();
  }

  function removeTask(taskId: string): void {
    abortControllers.get(taskId)?.();
    abortControllers.delete(taskId);
    items.value = items.value.filter((item) => item.id !== taskId);
    if (items.value.length === 0) {
      clearPollTimer();
    } else {
      schedulePolling();
    }
  }

  function clearFinished(): void {
    items.value = items.value.filter(
      (item) => !['cancelled', 'failed', 'ready'].includes(item.status),
    );
    if (items.value.length === 0) {
      trayDismissed.value = false;
      clearPollTimer();
    }
  }

  function dismissTray(): void {
    if (hasActiveTasks.value) {
      trayCollapsed.value = true;
      return;
    }
    clearFinished();
    trayDismissed.value = true;
  }

  function setTrayCollapsed(collapsed: boolean): void {
    trayCollapsed.value = collapsed;
  }

  function tasksForCompany(companyId: string): UploadQueueItem[] {
    return items.value.filter((item) => item.companyId === companyId && item.status !== 'cancelled');
  }

  function configureRuntime(config: UploadQueueRuntimeConfig): void {
    if (config.api) api = config.api;
    if (config.retryDelaysMs) retryDelaysMs = [...config.retryDelaysMs];
    if (typeof config.priorityPollMs === 'number') priorityPollMs = config.priorityPollMs;
    if (typeof config.fullPollMs === 'number') fullPollMs = config.fullPollMs;
    if (typeof config.maxConcurrentUploads === 'number') {
      maxConcurrentUploads = config.maxConcurrentUploads;
    }
  }

  function reset(): void {
    sessionInvalidated.value = false;
    sessionScope = null;
    activePoll = null;
    for (const abort of abortControllers.values()) {
      try {
        abort();
      } catch {
        // ignore
      }
    }
    abortControllers.clear();
    activeWorkers.clear();
    clearPollTimer();
    items.value = [];
    trayCollapsed.value = false;
    trayDismissed.value = false;
    assetVersion.value = 0;
    lastAssetUpdate.value = null;
    syncBeforeUnloadGuard(false);
    api = sellerDocumentsUploadApi;
    retryDelaysMs = [...DEFAULT_RETRY_DELAYS_MS];
    priorityPollMs = DEFAULT_PRIORITY_POLL_MS;
    fullPollMs = DEFAULT_FULL_POLL_MS;
    maxConcurrentUploads = DEFAULT_MAX_CONCURRENT_UPLOADS;
    if (channel) {
      try {
        channel.close();
      } catch {
        // ignore
      }
      channel = null;
    }
  }

  function invalidateSession(): void {
    reset();
    sessionInvalidated.value = true;
  }

  function setSessionScope(scope: string | null): void {
    if (scope === sessionScope) return;
    reset();
    sessionScope = scope;
    ensureBroadcastChannel();
  }

  return {
    $reset: reset,
    assetVersion,
    attentionCount,
    cancelTask,
    clearFinished,
    completedCount,
    configureRuntime,
    dismissTray,
    enqueueFiles,
    hasActiveTasks,
    hasBlockingTransfers,
    hasServerParsing,
    invalidateSession,
    items,
    lastAssetUpdate,
    pauseTask,
    pollOnce,
    removeTask,
    reset,
    resumeTask,
    restoreProcessing,
    retryTask,
    setSessionScope,
    setTrayCollapsed,
    tasksForCompany,
    trayCollapsed,
    trayDismissed,
  };
});

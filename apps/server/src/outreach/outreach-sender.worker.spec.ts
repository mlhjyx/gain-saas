import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import type { OutreachBatchLock } from './outreach-batch-lock.js';
import type { ClaimedSendJob } from './outreach-send-jobs.service.js';
import { OutreachSenderWorker } from './outreach-sender.worker.js';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BATCH = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-11T09:00:00Z');

function job(id: string, draftId: string, attempts = 1): ClaimedSendJob {
  return { id, workspaceId: WS, batchId: BATCH, draftId, attempts };
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    OUTREACH_SENDER_ENABLED: true,
    OUTREACH_SEND_ENABLED: true,
    CAMPAIGN_EXECUTION_SHADOW: false,
    OUTREACH_SENDER_INTERVAL_MS: 15_000,
    OUTREACH_SENDER_CLAIM_LIMIT: 20,
    OUTREACH_SEND_JOB_MAX_ATTEMPTS: 3,
    OUTREACH_SEND_JOB_RETRY_BACKOFF_SECONDS: '30,120,600',
    OUTREACH_SEND_JOB_DEFER_SECONDS: 1800,
    ...overrides,
  } as AppConfig;
}

function build(options: {
  claimed: ClaimedSendJob[];
  drafts: Array<{ id: string; status: string }>;
  sendError?: { response: { error: { code: string } } };
  locked?: boolean;
  configOverrides?: Partial<AppConfig>;
}) {
  const jobs = {
    claim: vi.fn(async () => options.claimed),
    markDone: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    markCancelled: vi.fn(async () => undefined),
    reschedule: vi.fn(async () => undefined),
  };
  const lock: OutreachBatchLock & { withLock: ReturnType<typeof vi.fn> } = {
    withLock: vi.fn(async (_batchId: string, fn: () => Promise<unknown>) => {
      if (options.locked) return { acquired: false };
      return { acquired: true, result: await fn() };
    }),
  } as never;
  const sends = {
    sendBatch: vi.fn(async () => {
      if (options.sendError) throw options.sendError;
      return { batchId: BATCH, status: 'QUEUED', sent: 0, failed: 0, skipped: 0, deferred: 0, shadowed: 0, results: [] };
    }),
  };
  const prisma = {
    outreachDraft: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        options.drafts.filter((draft) => where.id.in.includes(draft.id)),
      ),
    },
  };
  const worker = new OutreachSenderWorker(
    prisma as unknown as PrismaService,
    jobs as never,
    sends as never,
    lock,
    config(options.configOverrides),
  );
  return { worker, jobs, lock, sends };
}

describe('OutreachSenderWorker（P4-04 发送 job worker）', () => {
  it('按批次分组 + advisory lock：SENT/SKIPPED job 完成，顺延草稿重排到下一窗口', async () => {
    const { worker, jobs, lock, sends } = build({
      claimed: [job('j1', 'd1'), job('j2', 'd2')],
      drafts: [
        { id: 'd1', status: 'SENT' },
        { id: 'd2', status: 'APPROVED' },
      ],
    });

    const summary = await worker.runOnce(NOW);

    expect(lock.withLock).toHaveBeenCalledTimes(1);
    expect(sends.sendBatch).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ claimed: 2, done: 1, deferred: 1 });
    expect(jobs.markDone).toHaveBeenCalledWith(['j1']);
    expect(jobs.reschedule).toHaveBeenCalledWith(
      ['j2'],
      new Date(NOW.getTime() + 1800_000),
      'DEFERRED',
    );
  });

  it('发送台账 FAILED：按 attempts 退避重试，达到上限后置 FAILED', async () => {
    const { worker, jobs } = build({
      claimed: [job('j1', 'd1', 1), job('j2', 'd2', 3)],
      drafts: [
        { id: 'd1', status: 'FAILED' },
        { id: 'd2', status: 'FAILED' },
      ],
    });

    const summary = await worker.runOnce(NOW);

    expect(summary).toMatchObject({ retried: 1, failed: 1 });
    expect(jobs.reschedule).toHaveBeenCalledWith(
      ['j1'],
      new Date(NOW.getTime() + 30_000),
      'SMTP_DELIVERY_FAILED',
    );
    expect(jobs.markFailed).toHaveBeenCalledWith(['j2'], 'SMTP_DELIVERY_FAILED');
  });

  it('门拒绝（授权过期）：attempts 未满重试，attempts 已满失败', async () => {
    const { worker, jobs } = build({
      claimed: [job('j1', 'd1', 2)],
      drafts: [],
      sendError: { response: { error: { code: 'CAMPAIGN_AUTHORIZATION_EXPIRED' } } },
    });

    const summary = await worker.runOnce(NOW);
    expect(summary.retried).toBe(1);
    expect(jobs.reschedule).toHaveBeenCalledWith(
      ['j1'],
      new Date(NOW.getTime() + 120_000),
      'CAMPAIGN_AUTHORIZATION_EXPIRED',
    );
  });

  it('批次不存在：job 置 CANCELLED，不再重试', async () => {
    const { worker, jobs } = build({
      claimed: [job('j1', 'd1')],
      drafts: [],
      sendError: { response: { error: { code: 'OUTREACH_BATCH_NOT_FOUND' } } },
    });
    const summary = await worker.runOnce(NOW);
    expect(summary.cancelled).toBe(1);
    expect(jobs.markCancelled).toHaveBeenCalledWith(['j1']);
    expect(jobs.reschedule).not.toHaveBeenCalled();
  });

  it('锁被占用：整组推迟 60s（BATCH_LOCK_BUSY），不调用发送', async () => {
    const { worker, jobs, sends } = build({
      claimed: [job('j1', 'd1')],
      drafts: [],
      locked: true,
    });
    const summary = await worker.runOnce(NOW);
    expect(summary.locked).toBe(1);
    expect(sends.sendBatch).not.toHaveBeenCalled();
    expect(jobs.reschedule).toHaveBeenCalledWith(
      ['j1'],
      new Date(NOW.getTime() + 60_000),
      'BATCH_LOCK_BUSY',
    );
  });

  it('启动守卫：SENDER_ENABLED 打开但发送开关关闭或影子开启时不启动定时器', () => {
    const disabledSend = build({
      claimed: [],
      drafts: [],
      configOverrides: { OUTREACH_SEND_ENABLED: false },
    }).worker;
    disabledSend.onModuleInit();
    expect((disabledSend as unknown as { timer: unknown }).timer).toBeNull();

    const shadow = build({
      claimed: [],
      drafts: [],
      configOverrides: { CAMPAIGN_EXECUTION_SHADOW: true },
    }).worker;
    shadow.onModuleInit();
    expect((shadow as unknown as { timer: unknown }).timer).toBeNull();

    const enabled = build({ claimed: [], drafts: [] }).worker;
    enabled.onModuleInit();
    expect((enabled as unknown as { timer: unknown }).timer).not.toBeNull();
    enabled.onModuleDestroy();
  });
});

import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import {
  OUTREACH_BATCH_LOCK,
  type OutreachBatchLock,
} from './outreach-batch-lock.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import {
  OutreachSendJobsService,
  type ClaimedSendJob,
} from './outreach-send-jobs.service.js';
import { OutreachSendService } from './outreach-send.service.js';

export interface SenderRunSummary {
  claimed: number;
  done: number;
  retried: number;
  failed: number;
  deferred: number;
  cancelled: number;
  locked: number;
}

function noop(): SenderRunSummary {
  return { claimed: 0, done: 0, retried: 0, failed: 0, deferred: 0, cancelled: 0, locked: 0 };
}

function errorCodeOf(error: unknown, fallback: string): string {
  const code = (error as { response?: { error?: { code?: unknown } } })?.response?.error?.code;
  return typeof code === 'string' ? code : fallback;
}

/**
 * 发送 job worker（P4-04）：认领到期的发送 job → 批次级 advisory lock → 复用
 * OutreachSendService 的完整门序发送 → 按台账结果推进 job。
 * 双开关守卫：只有 OUTREACH_SENDER_ENABLED 且 OUTREACH_SEND_ENABLED 且影子关闭时才启动，
 * 避免影子模式下把 APPROVED 草稿无限顺延。
 */
@Injectable()
export class OutreachSenderWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly retryBackoff: number[];
  private readonly deferSeconds: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: OutreachSendJobsService,
    private readonly sends: OutreachSendService,
    @Inject(OUTREACH_BATCH_LOCK) private readonly lock: OutreachBatchLock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.retryBackoff = config.OUTREACH_SEND_JOB_RETRY_BACKOFF_SECONDS.split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);
    this.deferSeconds = config.OUTREACH_SEND_JOB_DEFER_SECONDS;
    this.maxAttempts = config.OUTREACH_SEND_JOB_MAX_ATTEMPTS;
  }

  onModuleInit(): void {
    if (!this.config.OUTREACH_SENDER_ENABLED) return;
    if (!this.config.OUTREACH_SEND_ENABLED || this.config.CAMPAIGN_EXECUTION_SHADOW) {
      // job 队列只在真实发送模式下轮询；影子/关闭状态由人工触发 send 端点做演练。
      return;
    }
    this.timer = setInterval(() => {
      void this.runOnce().catch(() => undefined);
    }, this.config.OUTREACH_SENDER_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(now: Date = new Date()): Promise<SenderRunSummary> {
    const summary = noop();
    if (this.running) return summary;
    this.running = true;
    try {
      const claimed = await this.jobs.claim(this.config.OUTREACH_SENDER_CLAIM_LIMIT, now);
      summary.claimed = claimed.length;
      const byBatch = new Map<string, ClaimedSendJob[]>();
      for (const job of claimed) {
        const list = byBatch.get(job.batchId) ?? [];
        list.push(job);
        byBatch.set(job.batchId, list);
      }
      for (const [batchId, batchJobs] of byBatch) {
        await this.processBatch(batchId, batchJobs, now, summary);
      }
      return summary;
    } finally {
      this.running = false;
    }
  }

  private async processBatch(
    batchId: string,
    jobs: ClaimedSendJob[],
    now: Date,
    summary: SenderRunSummary,
  ): Promise<void> {
    const ids = jobs.map((job) => job.id);
    const workspaceId = jobs[0]!.workspaceId;
    const tenant: OutreachTenant = {
      userId: 'outreach-worker',
      workspaceId,
      role: 'admin',
    };

    let sendErrorCode: string | null = null;
    const outcome = await this.lock.withLock(batchId, async () => {
      try {
        await this.sends.sendBatch(tenant, batchId);
      } catch (error) {
        sendErrorCode = errorCodeOf(error, 'OUTREACH_SEND_FAILED');
      }
    });

    if (!outcome.acquired) {
      // 另一个 worker 正在推进该批次：整组推迟，避免与对方竞争台账。
      await this.jobs.reschedule(ids, new Date(now.getTime() + 60_000), 'BATCH_LOCK_BUSY');
      summary.locked += ids.length;
      return;
    }
    if (sendErrorCode === 'OUTREACH_BATCH_NOT_FOUND') {
      await this.jobs.markCancelled(ids);
      summary.cancelled += ids.length;
      return;
    }
    if (sendErrorCode) {
      await this.rescheduleOrFail(jobs, now, sendErrorCode, summary);
      return;
    }

    const drafts = await this.prisma.outreachDraft.findMany({
      where: { id: { in: jobs.map((job) => job.draftId) } },
      select: { id: true, status: true },
    });
    const statusById = new Map(drafts.map((draft) => [draft.id, draft.status]));
    for (const job of jobs) {
      const status = statusById.get(job.draftId);
      if (status === 'SENT' || status === 'SKIPPED') {
        await this.jobs.markDone([job.id]);
        summary.done += 1;
      } else if (status === 'FAILED') {
        if (job.attempts >= this.maxAttempts) {
          await this.jobs.markFailed([job.id], 'SMTP_DELIVERY_FAILED');
          summary.failed += 1;
        } else {
          await this.jobs.reschedule(
            [job.id],
            new Date(now.getTime() + this.backoffSeconds(job.attempts) * 1000),
            'SMTP_DELIVERY_FAILED',
          );
          summary.retried += 1;
        }
      } else {
        // 顺延（窗口/限速/额度/半开小批）：草稿保持待发，稍后重试。
        await this.jobs.reschedule(
          [job.id],
          new Date(now.getTime() + this.deferSeconds * 1000),
          'DEFERRED',
        );
        summary.deferred += 1;
      }
    }
  }

  private async rescheduleOrFail(
    jobs: ClaimedSendJob[],
    now: Date,
    code: string,
    summary: SenderRunSummary,
  ): Promise<void> {
    for (const job of jobs) {
      if (job.attempts >= this.maxAttempts) {
        await this.jobs.markFailed([job.id], code);
        summary.failed += 1;
      } else {
        await this.jobs.reschedule(
          [job.id],
          new Date(now.getTime() + this.backoffSeconds(job.attempts) * 1000),
          code,
        );
        summary.retried += 1;
      }
    }
  }

  private backoffSeconds(attempts: number): number {
    if (this.retryBackoff.length === 0) return 30;
    const index = Math.min(Math.max(attempts - 1, 0), this.retryBackoff.length - 1);
    return this.retryBackoff[index]!;
  }
}

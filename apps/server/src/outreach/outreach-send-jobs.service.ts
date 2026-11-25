import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../shared/prisma.service.js';

/** 幂等键：同一批次的同一封草稿只入队一次（重复审批/重放被唯一键吸收）。 */
export function sendJobKey(batchId: string, draftId: string, stepNo = 1): string {
  return createHash('sha256').update(`${batchId}|${draftId}|${stepNo}`).digest('hex');
}

export interface ClaimedSendJob {
  id: string;
  workspaceId: string;
  batchId: string;
  draftId: string;
  attempts: number;
}

/**
 * 发送 job 队列（P4-04，Postgres 队列，无外部依赖）。
 * 认领用 claim_token 做原子归属：先取到期 PENDING，再以「state=PENDING」守卫批量改 CLAIMED，
 * 最后按 token 回读——并发 worker 各自拿到不相交集合（等价 SKIP LOCKED 的可用语义）。
 */
@Injectable()
export class OutreachSendJobsService {
  constructor(private readonly prisma: PrismaService) {}

  async claim(limit: number, now: Date): Promise<ClaimedSendJob[]> {
    const token = randomUUID();
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        workspace_id: string;
        batch_id: string;
        draft_id: string;
        attempts: number;
      }>
    >`SELECT id, workspace_id, batch_id, draft_id, attempts FROM public.app_claim_outreach_send_jobs(${limit}::integer, ${now}, ${token}::uuid)`;
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      batchId: row.batch_id,
      draftId: row.draft_id,
      attempts: row.attempts,
    }));
  }

  async markDone(workspaceId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.outreachSendJob.updateMany({
        where: { id: { in: ids }, workspaceId, state: 'CLAIMED' },
        data: { state: 'DONE', claimToken: null, lastError: null },
      }),
    );
  }

  async markFailed(workspaceId: string, ids: string[], error: string): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.outreachSendJob.updateMany({
        where: { id: { in: ids }, workspaceId, state: 'CLAIMED' },
        data: { state: 'FAILED', claimToken: null, lastError: error.slice(0, 1000) },
      }),
    );
  }

  async markCancelled(workspaceId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.outreachSendJob.updateMany({
        where: { id: { in: ids }, workspaceId, state: 'CLAIMED' },
        data: { state: 'CANCELLED', claimToken: null },
      }),
    );
  }

  async reschedule(workspaceId: string, ids: string[], nextAttemptAt: Date, error?: string): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.outreachSendJob.updateMany({
        where: { id: { in: ids }, workspaceId, state: 'CLAIMED' },
        data: {
          state: 'PENDING',
          claimToken: null,
          nextAttemptAt,
          ...(error ? { lastError: error.slice(0, 1000) } : {}),
        },
      }),
    );
  }

  async listByBatch(workspaceId: string, batchId: string) {
    return this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.outreachSendJob.findMany({
        where: { workspaceId, batchId },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }
}

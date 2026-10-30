import { Inject, Injectable } from '@nestjs/common';
import { Client, Connection, type ScheduleHandle } from '@temporalio/client';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';

/**
 * 运营端 Temporal 调度面(dev 集群 7233,无 TLS)。只做 schedule 列表/暂停恢复/触发/创建/删除
 * 和只读 workflow 查询;workflow 由引擎 worker 执行。平台集群 17233 有 JWT 边界,不在此模块。
 */
export const SCHEDULE_WORKFLOW_WHITELIST = [
  { type: 'acquisitionSweepWorkflow', label: '采集 sweep' },
  { type: 'intentSweepWorkflow', label: '意向 sweep' },
  { type: 'backlogSweepWorkflow', label: '存量对账 sweep' },
  { type: 'externalIntentSweepWorkflow', label: '外部意向 sweep' },
  { type: 'sanctionsRefreshWorkflow', label: '制裁名单刷新' },
  { type: 'patentsCacheRefreshWorkflow', label: '专利缓存刷新' },
  { type: 'rawRetentionSweepWorkflow', label: 'raw 保留期清理' },
] as const;

const TASK_QUEUE = 'understanding';

/**
 * 运营台的 workflow 列表只看引擎获客/合规主链路;同 namespace 下还有 site-builder 等
 * 其他产品线的每分钟 sweep,不在此页展示(避免把真正的获客 run 挤出前 50 条)。
 */
const ACQUISITION_WORKFLOW_TYPES = new Set([
  'understandingWorkflow',
  'qualifyWorkflow',
  'discoveryWorkflow',
  'deletionWorkflow',
  'kbIngestWorkflow',
  'refurbishWorkflow',
  'acquisitionSweepWorkflow',
  'intentSweepWorkflow',
  'backlogSweepWorkflow',
  'externalIntentSweepWorkflow',
  'sanctionsRefreshWorkflow',
  'patentsCacheRefreshWorkflow',
  'rawRetentionSweepWorkflow',
  'assetObjectCleanupWorkflow',
  'personalArtifactCleanupWorkflow',
]);

@Injectable()
export class OpsTemporalService {
  private connection: Connection | null = null;
  private client: Client | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private async getClient(): Promise<Client> {
    if (!this.client) {
      this.connection = await Connection.connect({ address: this.config.TEMPORAL_ADDRESS });
      this.client = new Client({ connection: this.connection, namespace: this.config.TEMPORAL_NAMESPACE });
    }
    return this.client;
  }

  private async reset(): Promise<void> {
    this.client = null;
    const connection = this.connection;
    this.connection = null;
    await connection?.close().catch(() => undefined);
  }

  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.getClient());
    } catch (error) {
      await this.reset();
      try {
        return await fn(await this.getClient());
      } catch (retryError) {
        throw retryError instanceof Error ? retryError : (error as Error);
      }
    }
  }

  private handle(client: Client, id: string): ScheduleHandle {
    return client.schedule.getHandle(id);
  }

  async listSchedules(): Promise<
    Array<{ id: string; workflowType: string; taskQueue: string; paused: boolean; note: string | null; intervalMinutes: number | null; overlap: string | null }>
  > {
    return this.withClient(async (client) => {
      const out: Array<{ id: string; workflowType: string; taskQueue: string; paused: boolean; note: string | null; intervalMinutes: number | null; overlap: string | null }> = [];
      for await (const summary of client.schedule.list()) {
        const id = summary.scheduleId;
        try {
          const detail = await this.handle(client, id).describe();
          const every = detail.spec.intervals?.[0]?.every;
          out.push({
            id,
            workflowType: String(detail.action?.workflowType ?? ''),
            taskQueue: String(detail.action?.taskQueue ?? ''),
            paused: Boolean(detail.state.paused),
            note: detail.state.note ?? null,
            intervalMinutes: every ? Math.round(Number(every) / 60_000) : null,
            overlap: (detail.policies?.overlap as string) ?? null,
          });
        } catch {
          // 单个 describe 失败不拖垮整页
        }
      }
      return out;
    });
  }

  async pause(id: string, note?: string): Promise<void> {
    await this.withClient((client) => this.handle(client, id).pause(note));
  }
  async unpause(id: string): Promise<void> {
    await this.withClient((client) => this.handle(client, id).unpause());
  }
  async trigger(id: string): Promise<void> {
    await this.withClient((client) => this.handle(client, id).trigger());
  }
  async remove(id: string): Promise<void> {
    await this.withClient((client) => this.handle(client, id).delete());
  }

  async create(input: { scheduleId: string; workflowType: string; intervalMinutes: number; note?: string }): Promise<void> {
    if (!SCHEDULE_WORKFLOW_WHITELIST.some((item) => item.type === input.workflowType)) {
      throw new Error(`workflowType 不在白名单:${input.workflowType}`);
    }
    await this.withClient(async (client) => {
      await client.schedule.create({
        scheduleId: input.scheduleId,
        spec: { intervals: [{ every: input.intervalMinutes * 60_000 }] },
        policies: { overlap: 'SKIP' },
        action: { type: 'startWorkflow', workflowType: input.workflowType, taskQueue: TASK_QUEUE, args: [] },
        state: { note: input.note ?? 'created by GainOS ops console' },
      });
    });
  }

  async listWorkflows(status?: string, limit = 50): Promise<
    Array<{ workflowId: string; runId: string; workflowType: string; status: string; startTime: string | null; closeTime: string | null; executionTime: string | null }>
  > {
    return this.withClient(async (client) => {
      const query = status === 'Running'
        ? "ExecutionStatus = 'Running'"
        : status
          ? `ExecutionStatus = '${status}'`
          : "ExecutionStatus != 'Running'";
      const statusName = (value: unknown): string => {
        if (typeof value === 'string') return value;
        if (value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string') {
          return (value as { name: string }).name;
        }
        return value === undefined || value === null ? '—' : String(value);
      };
      const out: Array<{ workflowId: string; runId: string; workflowType: string; status: string; startTime: string | null; closeTime: string | null; executionTime: string | null }> = [];
      for await (const workflow of client.workflow.list({ query })) {
        const workflowType = String(workflow.type ?? '');
        if (!ACQUISITION_WORKFLOW_TYPES.has(workflowType)) continue;
        out.push({
          workflowId: workflow.workflowId,
          runId: workflow.runId,
          workflowType,
          status: statusName(workflow.status),
          startTime: workflow.startTime ? new Date(workflow.startTime).toISOString() : null,
          closeTime: workflow.closeTime ? new Date(workflow.closeTime).toISOString() : null,
          executionTime: workflow.executionTime ? new Date(workflow.executionTime).toISOString() : null,
        });
        if (out.length >= limit) break;
      }
      return out;
    });
  }

  async health(): Promise<boolean> {
    try {
      await this.withClient((client) => client.connection.workflowService.getSystemInfo({}));
      return true;
    } catch {
      return false;
    }
  }
}

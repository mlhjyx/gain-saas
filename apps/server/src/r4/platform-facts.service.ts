import { Inject, Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import type { CapabilityObservation } from './capability-issuer.service.js';

/**
 * capability 的事实采集（P3b）。
 *
 * 三类事实：
 *  - 部署绑定（文件）：backendSha / 镜像与制品摘要 / validUntil —— 由运维工具生成，7 天有效
 *  - Temporal schedule 事实：每个 schedule 的 workflowType/taskQueue/权限证明（探针注入）
 *  - 撤销消费者事实：租约心跳与积压（探针注入）
 *
 * 任何一类缺失或过期都返回 unavailable，由控制器转成 503 —— 引擎只认「新鲜且完整」的能力。
 */

export interface DeploymentBinding {
  backendSha: string;
  growthosSha?: string;
  policyDigest?: string;
  /** 运维工具生成的时间戳是 epoch 毫秒（与引擎绑定同源），也接受 ISO 字符串。 */
  validUntil: number | string;
}

/** 绑定文件里的时间既可能是 epoch 毫秒也可能是 ISO 字符串，统一折算成毫秒。 */
export function bindingInstant(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return Date.parse(value);
  return Number.NaN;
}

export interface TemporalScheduleFact {
  scheduleId: string;
  workflowType: string;
  taskQueue: string;
  mode: CapabilityObservation['mode'];
}

export interface RevocationConsumerFact {
  scheduleId: string;
  observedAt: number;
  validUntil: number;
  undeliveredCount: number;
  oldestUndeliveredCreatedAt: number | null;
}

/** 探针：真实实现接 Temporal 与引擎库；未配置时返回 null 表示不可用。 */
export interface TemporalScheduleProbe {
  read(now: number): Promise<TemporalScheduleFact[] | null>;
}

export interface RevocationBacklogProbe {
  read(now: number): Promise<RevocationConsumerFact[] | null>;
}

export const TEMPORAL_SCHEDULE_PROBE = Symbol('TEMPORAL_SCHEDULE_PROBE');
export const REVOCATION_BACKLOG_PROBE = Symbol('REVOCATION_BACKLOG_PROBE');

export class PlatformFactsUnavailable extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** 至少「有事实」的窗口：引擎要求事实观测时间距签发 < 1 秒，这里留出调用耗时。 */
const FACT_WINDOW_MS = 20_000;

@Injectable()
export class PlatformFactsService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(TEMPORAL_SCHEDULE_PROBE) private readonly schedules: TemporalScheduleProbe,
    @Inject(REVOCATION_BACKLOG_PROBE) private readonly backlog: RevocationBacklogProbe,
  ) {}

  readBinding(now = Date.now()): DeploymentBinding {
    const file = this.config.R4_DEPLOYMENT_BINDING_FILE;
    if (!file) throw new PlatformFactsUnavailable('未配置部署绑定文件');
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw new PlatformFactsUnavailable(`部署绑定不可读: ${(error as Error).message}`);
    }
    const binding = raw as Partial<DeploymentBinding> & { revokedAt?: unknown };
    if (typeof binding.backendSha !== 'string' || !/^[0-9a-f]{7,40}$/.test(binding.backendSha))
      throw new PlatformFactsUnavailable('部署绑定缺少合法的 backendSha');
    // 显式撤销：capability 必须 fail closed（撤销请求由 gain-saas 的监视器签发）。
    if (Number.isFinite(bindingInstant(binding.revokedAt)))
      throw new PlatformFactsUnavailable('部署绑定已被显式撤销');
    const validUntil = bindingInstant(binding.validUntil);
    if (Number.isNaN(validUntil)) throw new PlatformFactsUnavailable('部署绑定缺少合法的 validUntil');
    if (validUntil <= now) throw new PlatformFactsUnavailable('部署绑定已过期');
    return binding as DeploymentBinding;
  }

  async collect(now = Date.now()): Promise<{ observations: CapabilityObservation[]; binding: DeploymentBinding }> {
    const binding = this.readBinding(now);
    const [schedules, backlog] = await Promise.all([
      this.schedules.read(now),
      this.backlog.read(now),
    ]);
    if (!schedules || schedules.length === 0) throw new PlatformFactsUnavailable('Temporal schedule 事实不可用');
    if (!backlog) throw new PlatformFactsUnavailable('撤销消费者事实不可用');

    const byId = new Map(backlog.map((row) => [row.scheduleId, row]));
    const validUntil = Math.min(bindingInstant(binding.validUntil), now + FACT_WINDOW_MS);
    const observations = schedules.map((schedule) => {
      const consumer = byId.get(schedule.scheduleId);
      if (!consumer) throw new PlatformFactsUnavailable(`缺少消费者事实: ${schedule.scheduleId}`);
      return {
        scheduleId: schedule.scheduleId,
        workflowType: schedule.workflowType,
        taskQueue: schedule.taskQueue,
        mode: schedule.mode,
        // Temporal 读与绑定校验是同一次调用内的观测，故共用 now。
        temporalPermission: { status: 'ok' as const, observedAt: now, validUntil },
        issuer: { status: 'ok' as const, observedAt: now, validUntil },
        revocationConsumer: {
          status: 'ok' as const,
          observedAt: consumer.observedAt,
          validUntil: Math.min(consumer.validUntil, consumer.observedAt + FACT_WINDOW_MS),
        },
        undeliveredCount: consumer.undeliveredCount,
        oldestUndeliveredCreatedAt: consumer.oldestUndeliveredCreatedAt,
      };
    });
    return { observations, binding };
  }
}

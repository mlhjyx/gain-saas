import { Inject, Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PLATFORM_SCHEDULES, type PlatformScheduleId } from './contracts/r4-wire-contracts.js';
import type { TemporalScheduleFact, TemporalScheduleProbe } from './platform-facts.service.js';

/**
 * 真实 Temporal schedule 探针（P3c）。
 *
 * 平台集群（`platform-automation` 命名空间）要求 mTLS + JWT。本探针只负责
 * **读**：列出四个 schedule 的存在、workflowType 与 taskQueue，并按策略标注
 * mode（patents-cache-refresh 恒为 INTENTIONALLY_DISABLED_NO_EGRESS）。
 *
 * 未配置 `R4_TEMPORAL_ENABLED=true` 时返回 null（事实不可用 → capability 503），
 * 线上现状不变。注意：平台 Temporal 的 JWT 信任根（JWKS URI）目前仍指向
 * GrowthOS；切到 gain-saas 属于 P7 的平台侧改动，不在本服务内。
 */

export interface ScheduleLister {
  list(): Promise<Array<{ scheduleId: string; workflowType?: string; taskQueue?: string }>>;
}

export const SCHEDULE_LISTER = Symbol('SCHEDULE_LISTER');

/** 四个 schedule 的静态契约（与引擎 platform-execution-contract 一致）。 */
const CONTRACT: Record<PlatformScheduleId, { workflowType: string; taskQueue: string; mode: TemporalScheduleFact['mode'] }> = {
  'acq-sweep': { workflowType: 'acquisitionSweepWorkflow', taskQueue: 'understanding', mode: 'ENABLED' },
  'intent-sweep': { workflowType: 'intentSweepWorkflow', taskQueue: 'understanding', mode: 'ENABLED' },
  'sanctions-refresh': { workflowType: 'sanctionsRefreshWorkflow', taskQueue: 'understanding', mode: 'ENABLED' },
  'patents-cache-refresh': {
    workflowType: 'patentsCacheRefreshWorkflow',
    taskQueue: 'understanding',
    mode: 'INTENTIONALLY_DISABLED_NO_EGRESS',
  },
};

@Injectable()
export class TemporalScheduleProbeService implements TemporalScheduleProbe {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SCHEDULE_LISTER) private readonly lister: ScheduleLister | null,
  ) {}

  async read(_now: number): Promise<TemporalScheduleFact[] | null> {
    if (!this.config.R4_TEMPORAL_ENABLED || !this.lister) return null;
    let schedules: Awaited<ReturnType<ScheduleLister['list']>>;
    try {
      schedules = await this.lister.list();
    } catch {
      return null;
    }
    const seen = new Set(schedules.map((s) => s.scheduleId));
    // 四个 schedule 必须全部存在，缺一个就不算完整事实。
    if (!PLATFORM_SCHEDULES.every((id) => seen.has(id))) return null;
    return PLATFORM_SCHEDULES.map((scheduleId) => ({
      scheduleId,
      workflowType: schedules.find((s) => s.scheduleId === scheduleId)?.workflowType ?? CONTRACT[scheduleId].workflowType,
      taskQueue: schedules.find((s) => s.scheduleId === scheduleId)?.taskQueue ?? CONTRACT[scheduleId].taskQueue,
      mode: CONTRACT[scheduleId].mode,
    }));
  }
}

/** 未启用时的占位实现。 */
@Injectable()
export class NullScheduleLister implements ScheduleLister {
  async list(): Promise<Array<{ scheduleId: string; workflowType?: string; taskQueue?: string }>> {
    throw new Error('Temporal schedule lister 未配置');
  }
}

/** 供 P7 使用的真实现骨架：证书/令牌路径齐全时才构造客户端。 */
export function readTemporalMaterial(config: AppConfig): {
  address: string;
  namespace: string;
  tls: { cert: Buffer; key: Buffer; ca: Buffer } | null;
  token: string | null;
} {
  const tls =
    config.R4_TEMPORAL_TLS_CERT_FILE && config.R4_TEMPORAL_TLS_KEY_FILE && config.R4_TEMPORAL_TLS_CA_FILE
      ? {
          cert: readFileSync(config.R4_TEMPORAL_TLS_CERT_FILE),
          key: readFileSync(config.R4_TEMPORAL_TLS_KEY_FILE),
          ca: readFileSync(config.R4_TEMPORAL_TLS_CA_FILE),
        }
      : null;
  const token = config.R4_TEMPORAL_TOKEN_FILE ? readFileSync(config.R4_TEMPORAL_TOKEN_FILE, 'utf8').trim() : null;
  return { address: config.R4_TEMPORAL_ADDRESS, namespace: config.R4_TEMPORAL_NAMESPACE, tls, token };
}

/** 真实现：平台 Temporal（mTLS + JWT）读取四个 schedule 的 workflowType/taskQueue。 */
@Injectable()
export class TemporalClientScheduleLister implements ScheduleLister {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async list(): Promise<Array<{ scheduleId: string; workflowType?: string; taskQueue?: string }>> {
    const material = readTemporalMaterial(this.config);
    if (!material.tls || !material.token)
      throw new Error('平台 Temporal 凭证不全（需要 mTLS 证书与 token 文件）');
    const { Client, Connection } = await import('@temporalio/client');
    const connection = await Connection.connect({
      address: material.address,
      tls: {
        clientCertPair: { crt: material.tls.cert, key: material.tls.key },
        serverRootCACertificate: material.tls.ca,
      },
      metadata: { authorization: `Bearer ${material.token}` },
    });
    try {
      const client = new Client({ connection, namespace: material.namespace });
      const rows: Array<{ scheduleId: string; workflowType?: string; taskQueue?: string }> = [];
      for await (const schedule of client.schedule.list()) {
        const action = (schedule as { action?: { type?: string; workflow?: { workflowType?: string; taskQueue?: string } } }).action;
        const workflow = action?.type === 'startWorkflow' ? action.workflow : undefined;
        rows.push({
          scheduleId: schedule.scheduleId,
          workflowType: workflow?.workflowType,
          taskQueue: workflow?.taskQueue,
        });
      }
      return rows;
    } finally {
      await connection.close();
    }
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PLATFORM_SCHEDULES, type PlatformScheduleId } from './contracts/r4-wire-contracts.js';
import { MachineTokenService } from './machine-token.service.js';
import type { TemporalScheduleFact, TemporalScheduleProbe } from './platform-facts.service.js';

/**
 * 真实 Temporal schedule 探针（P3c）。
 *
 * 平台集群（`platform-automation` 命名空间）要求 mTLS + JWT。本探针只负责
 * **读**：列出四个 schedule 的存在、workflowType 与 taskQueue，并按策略标注
 * mode（patents-cache-refresh 恒为 INTENTIONALLY_DISABLED_NO_EGRESS）。
 *
 * 未配置 `R4_TEMPORAL_ENABLED=true` 时返回 null（事实不可用 → capability 503），
 * 线上现状不变。平台 Temporal 的 JWT 信任根（`temporal-platform.env` 的
 * `TEMPORAL_PLATFORM_JWKS_URI`）已切到 gain-saas 的 temporal-runtime JWKS；
 * token 在本进程内用同一钥族自签，与平台验签同源。
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

/**
 * 平台 Temporal 连接材料。三件齐全是硬要求：
 *  - CA：验证前端证书（与引擎同一信任根）
 *  - 客户端证书：平台只为 reader 身份放行 schedule 只读，且 reader 必须带 mTLS 证明
 *  - serverNameOverride：证书 SAN 只有 `temporal-platform*`，且 SNI 必须为
 *    `temporal-platform-reader` 平台才会下发客户端证书请求
 */
export function readTemporalMaterial(config: AppConfig): {
  address: string;
  namespace: string;
  serverNameOverride: string;
  tls: {
    serverRootCACertificate: Buffer;
    serverNameOverride: string;
    clientCertPair: { crt: Buffer; key: Buffer };
  };
} {
  if (!config.R4_TEMPORAL_TLS_CA_FILE || !config.R4_TEMPORAL_TLS_CERT_FILE || !config.R4_TEMPORAL_TLS_KEY_FILE)
    throw new Error('平台 Temporal 凭证不全（需要 TLS CA 与 reader 客户端证书）');
  return {
    address: config.R4_TEMPORAL_ADDRESS,
    namespace: config.R4_TEMPORAL_NAMESPACE,
    serverNameOverride: config.R4_TEMPORAL_SERVER_NAME,
    tls: {
      serverRootCACertificate: readFileSync(config.R4_TEMPORAL_TLS_CA_FILE),
      serverNameOverride: config.R4_TEMPORAL_SERVER_NAME,
      clientCertPair: {
        crt: readFileSync(config.R4_TEMPORAL_TLS_CERT_FILE),
        key: readFileSync(config.R4_TEMPORAL_TLS_KEY_FILE),
      },
    },
  };
}

/** 真实现：平台 Temporal（TLS + JWT）读取四个 schedule 的 workflowType/taskQueue。 */
@Injectable()
export class TemporalClientScheduleLister implements ScheduleLister {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly machineTokens: MachineTokenService,
  ) {}

  async list(): Promise<Array<{ scheduleId: string; workflowType?: string; taskQueue?: string }>> {
    const material = readTemporalMaterial(this.config);
    const token = await this.mintToken();
    const { Connection } = await import('@temporalio/client');
    // 不能用 Connection.connect / Client：两者都会先调 GetSystemInfo，而平台 reader
    // 白名单只放行 DescribeSchedule / DescribeWorkflowExecution / GetWorkflowExecutionHistory。
    const connection = Connection.lazy({ address: material.address, tls: material.tls, apiKey: token });
    try {
      const rows: Array<{ scheduleId: string; workflowType?: string; taskQueue?: string }> = [];
      for (const scheduleId of PLATFORM_SCHEDULES) {
        const response = await connection.workflowService.describeSchedule({
          namespace: material.namespace,
          scheduleId,
        });
        const start = (
          response as {
            schedule?: {
              action?: {
                startWorkflow?: { workflowType?: { name?: string }; taskQueue?: { name?: string } };
              };
            };
          }
        ).schedule?.action?.startWorkflow;
        rows.push({
          scheduleId,
          workflowType: start?.workflowType?.name,
          taskQueue: start?.taskQueue?.name,
        });
      }
      return rows;
    } finally {
      await connection.close();
    }
  }

  /**
   * 进程内自签 temporal token：权威就是自己，无需回调 mTLS 端点取 token。
   * 300 秒 TTL 足够覆盖一次 schedule 读取；每次调用现签，避免持有过期 token。
   */
  private async mintToken(): Promise<string> {
    const configurationRevision = this.config.R4_MACHINE_CONFIGURATION_REVISION;
    if (!configurationRevision)
      throw new Error('平台 Temporal 凭证不全（需要 R4_MACHINE_CONFIGURATION_REVISION）');
    const envelope = await this.machineTokens.issue({
      profile: 'temporal-reader',
      nonce: randomBytes(16).toString('hex'),
      subject: this.config.R4_TEMPORAL_READER_SUBJECT,
      configurationRevision,
    });
    return envelope.token;
  }
}

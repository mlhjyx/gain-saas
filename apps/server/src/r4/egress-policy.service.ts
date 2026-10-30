import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import { PLATFORM_SCHEDULES, type PlatformScheduleId } from './contracts/r4-wire-contracts.js';

/**
 * egress 策略的差异判断与安装（P3d）。
 *
 * 设计见 docs/technical/r4-egress-policy-migration.md。三条不变量：
 *  - 期望值只来自引擎报价，本服务不做任何策略数学
 *  - `patents-cache-refresh` 永不安装（按设计没有 egress）
 *  - 安装必须带 expectedGeneration，与库中不一致即拒绝；generation 只前进
 */

export interface FenceRow {
  scheduleId: string;
  generation: number;
  state: string;
  policyArtifactSha256: string;
  executionEnvelopeSha256: string;
  requiredCapMicrousd: string;
}

export interface ExpectedPolicy {
  policyRevision: string;
  policyArtifactSha256: string;
  executionEnvelopeSha256: string;
  requiredCapMicrousd: string;
}

export interface InstallParams {
  scheduleId: string;
  expectedGeneration: number;
  policyArtifactSha256: string;
  executionEnvelopeSha256: string;
  requiredCapMicrousd: string;
}

export interface FenceStore {
  readAll(): Promise<FenceRow[]>;
  install(params: InstallParams): Promise<{ generation: number; replay: boolean }>;
}

export interface QuoteSource {
  expected(): Promise<Map<string, ExpectedPolicy>>;
}

export const FENCE_STORE = Symbol('FENCE_STORE');
export const QUOTE_SOURCE = Symbol('QUOTE_SOURCE');

export type DryRunAction = 'NONE' | 'INSTALL' | 'BLOCKED';

export interface DryRunEntry {
  scheduleId: string;
  action: DryRunAction;
  reason?: string;
  current?: FenceRow;
  expected?: ExpectedPolicy;
}

@Injectable()
export class EgressPolicyService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FENCE_STORE) private readonly store: FenceStore,
    @Inject(QUOTE_SOURCE) private readonly quotes: QuoteSource,
    private readonly prisma: PrismaService,
  ) {}

  async dryRun(): Promise<DryRunEntry[]> {
    const [rows, expected] = await Promise.all([this.store.readAll(), this.quotes.expected()]);
    return PLATFORM_SCHEDULES.map((scheduleId) => this.diff(scheduleId, rows, expected));
  }

  /** 真实安装。调用方必须显式给出 expectedGeneration。 */
  async install(scheduleId: PlatformScheduleId, expectedGeneration: number, operator: string): Promise<{ generation: number; replay: boolean }> {
    if (scheduleId === 'patents-cache-refresh') throw new Error('patents-cache-refresh 按设计没有 egress,不得安装');
    const [rows, expected] = await Promise.all([this.store.readAll(), this.quotes.expected()]);
    const entry = this.diff(scheduleId, rows, expected);
    if (entry.action !== 'INSTALL' || !entry.current || !entry.expected)
      throw new Error(`不能安装 ${scheduleId}: ${entry.reason ?? entry.action}`);
    if (entry.current.generation !== expectedGeneration)
      throw new Error(`generation 不匹配: 库中 ${entry.current.generation}, 请求 ${expectedGeneration}`);

    const result = await this.store.install({
      scheduleId,
      expectedGeneration,
      policyArtifactSha256: entry.expected.policyArtifactSha256,
      executionEnvelopeSha256: entry.expected.executionEnvelopeSha256,
      requiredCapMicrousd: entry.expected.requiredCapMicrousd,
    });
    await this.prisma.r4EgressInstallAudit.create({
      data: {
        scheduleId,
        fromGeneration: BigInt(expectedGeneration),
        toGeneration: BigInt(result.generation),
        policyArtifactSha256: entry.expected.policyArtifactSha256,
        executionEnvelopeSha256: entry.expected.executionEnvelopeSha256,
        requiredCapMicrousd: BigInt(entry.expected.requiredCapMicrousd),
        quotePolicyRevision: entry.expected.policyRevision,
        operator,
      },
    });
    return result;
  }

  private diff(scheduleId: string, rows: FenceRow[], expected: Map<string, ExpectedPolicy>): DryRunEntry {
    if (scheduleId === 'patents-cache-refresh')
      return { scheduleId, action: 'BLOCKED', reason: '按设计没有 egress' };
    const want = expected.get(scheduleId);
    if (!want) return { scheduleId, action: 'BLOCKED', reason: '报价未给出该 schedule' };
    const current = rows.find((row) => row.scheduleId === scheduleId);
    if (!current) return { scheduleId, action: 'BLOCKED', reason: '库中没有该 schedule 的围栏行', expected: want };
    if (current.state !== 'ACTIVE')
      return { scheduleId, action: 'BLOCKED', reason: `状态为 ${current.state}，需人工决定是否重开`, current, expected: want };
    const same =
      current.policyArtifactSha256 === want.policyArtifactSha256 &&
      current.executionEnvelopeSha256 === want.executionEnvelopeSha256 &&
      current.requiredCapMicrousd === want.requiredCapMicrousd;
    return same ? { scheduleId, action: 'NONE', current, expected: want } : { scheduleId, action: 'INSTALL', current, expected: want };
  }
}

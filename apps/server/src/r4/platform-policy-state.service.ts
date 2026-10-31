import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import { AuditService } from '../shared/audit.service.js';
import { PlatformRevocationService, ACTIVE_REQUEST_STATES, EGRESS_SCHEDULES } from './platform-revocation.service.js';

/**
 * 平台策略状态的持久镜像（P9 政策停用 → 撤销）。
 *
 * 后端 policy asset 的 `desired_mode` 是引擎 readiness 的事实来源；gain-saas 用
 * `R4_PLATFORM_POLICY_MODES` 镜像同三个有 egress 的 schedule，并持久化到
 * `r4_platform_policy_state`：
 *  - 首次见到某个 schedule：只建立基线，不触发撤销（新库/新部署没有在途运行）；
 *  - ENABLED→DISABLED：创建 POLICY_DISABLED 撤销请求（受重开路径门控，见设计 §6）；
 *  - DISABLED→ENABLED：只记录，不重开围栏——重开是后端的受审计路径。
 *
 * 两侧（后端 policy asset 与这里）必须在同一发布窗口切换；不一致时引擎的
 * capability 校验会失败并让 readiness not ready（fail closed），这是刻意行为。
 */

export const PLATFORM_POLICY_GUARD = Symbol('PLATFORM_POLICY_GUARD');

export type PlatformPolicyMode = 'ENABLED' | 'DISABLED';

export interface ConfiguredPolicyMode {
  scheduleId: (typeof EGRESS_SCHEDULES)[number];
  mode: PlatformPolicyMode;
}

/** Grant 签发的策略门：策略停用或有未结撤销请求时拒绝新 Grant。 */
export interface PlatformGrantPolicyGuard {
  assertIssuable(scheduleId: string): Promise<void>;
}

export class PlatformPolicyDenied extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

@Injectable()
export class PlatformPolicyStateService implements PlatformGrantPolicyGuard {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly revocations: PlatformRevocationService,
    private readonly audit: AuditService,
  ) {}

  /** 解析并校验配置镜像；只允许三个有 egress 的 schedule，缺一或多一都拒绝。 */
  configuredModes(): ConfiguredPolicyMode[] {
    let raw: unknown;
    try {
      raw = JSON.parse(this.config.R4_PLATFORM_POLICY_MODES);
    } catch {
      throw new Error('R4_PLATFORM_POLICY_MODES 不是合法 JSON');
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('R4_PLATFORM_POLICY_MODES 必须是对象');
    const record = raw as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== EGRESS_SCHEDULES.length
      || !EGRESS_SCHEDULES.every((scheduleId) => Object.hasOwn(record, scheduleId)))
      throw new Error('R4_PLATFORM_POLICY_MODES 必须且只能包含三个有 egress 的 schedule');
    return EGRESS_SCHEDULES.map((scheduleId) => {
      const mode = record[scheduleId];
      if (mode !== 'ENABLED' && mode !== 'DISABLED')
        throw new Error(`R4_PLATFORM_POLICY_MODES.${scheduleId} 必须是 ENABLED 或 DISABLED`);
      return { scheduleId, mode };
    });
  }

  /** 把配置镜像同步到持久状态；只在状态转换时产生副作用。 */
  async sync(): Promise<void> {
    for (const { scheduleId, mode } of this.configuredModes()) {
      const existing = await this.prisma.r4PlatformPolicyState.findUnique({ where: { scheduleId } });
      if (!existing) {
        try {
          await this.prisma.r4PlatformPolicyState.create({
            data: { scheduleId, mode, updatedBy: 'policy-config-baseline' },
          });
        } catch (error) {
          if ((error as { code?: string }).code !== 'P2002') throw error;
        }
        continue;
      }
      if (existing.mode === mode) continue;
      const updated = await this.prisma.r4PlatformPolicyState.updateMany({
        where: { scheduleId, mode: existing.mode },
        data: { mode, updatedBy: 'policy-config' },
      });
      if (updated.count !== 1) continue;
      await this.audit.record({
        realm: 'service', actorId: 'policy-config', action: 'r4.policy-state.transition',
        target: scheduleId, detail: { from: existing.mode, to: mode },
      });
      if (mode === 'DISABLED') {
        await this.revocations.create({
          scheduleId,
          reasonCode: 'POLICY_DISABLED',
          source: 'POLICY_STATE',
          requestedBy: 'policy-config',
          note: 'policy mode ENABLED→DISABLED（部署期受评审的策略状态变更）',
        });
      }
    }
  }

  async assertIssuable(scheduleId: string): Promise<void> {
    const state = await this.prisma.r4PlatformPolicyState.findUnique({ where: { scheduleId } });
    if (state?.mode === 'DISABLED')
      throw new PlatformPolicyDenied(
        'PLATFORM_GRANT_POLICY_DISABLED', `${scheduleId} 的策略状态为 DISABLED`,
      );
    const active = await this.prisma.r4RevocationRequest.findFirst({
      where: { scheduleId, state: { in: [...ACTIVE_REQUEST_STATES] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, state: true },
    });
    if (active)
      throw new PlatformPolicyDenied(
        'PLATFORM_GRANT_REVOCATION_PENDING',
        `${scheduleId} 有未结的撤销请求（${active.state}）`,
      );
  }

  async readAll() {
    return this.prisma.r4PlatformPolicyState.findMany({ orderBy: { scheduleId: 'asc' } });
  }
}

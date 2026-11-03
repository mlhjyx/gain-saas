import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AppConfig } from '../config/configuration.js';
import { APP_CONFIG } from '../shared/config.module.js';
import { PrismaService } from '../shared/prisma.service.js';

/** 只有付费 run 的签发计入 run 次数上限；花费上限对所有签发生效。 */
const RUN_PURPOSE = 'discovery.run';

export type WorkspaceBudgetDenyReason = 'RUNS' | 'SPEND';

export interface WorkspaceBudgetDecision {
  allowed: boolean;
  reason?: WorkspaceBudgetDenyReason;
  /** false = 该 workspace 被豁免（policy.enabled=false）`. */
  enforced: boolean;
  purpose: string;
  windowDays: number;
  maxRuns: number;
  usedRuns: number | null;
  maxSpendMicros: bigint;
  usedSpendMicros: bigint;
}

/**
 * workspace 累计预算/配额（Phase 1b 拒绝钱包攻击）。
 *
 * 在 gain-saas 签发一次性 Grant 之前强制：窗口内 run 次数与已花费都从事实表
 * （discovery_run_link / cost_ledger）现算，不维护易漂移的余额字段。签发是唯一
 * 收费闸门（Grant 只能由本服务签出），所以这里等价于引擎侧强制。
 */
@Injectable()
export class WorkspaceBudgetPolicyService {
  private readonly logger = new Logger(WorkspaceBudgetPolicyService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async assertGrantAllowed(workspaceId: string, purpose: string): Promise<void> {
    const decision = await this.evaluate(workspaceId, purpose);
    if (decision.allowed) return;
    if (!this.config.WORKSPACE_QUOTA_ENFORCE) {
      this.logger.warn(
        `workspace ${workspaceId} 超出配额（${decision.reason}）：purpose=${purpose} ` +
          `runs=${decision.usedRuns ?? '-'}/${decision.maxRuns} ` +
          `spend=${decision.usedSpendMicros}/${decision.maxSpendMicros} microUSD（enforce=false，只记录）`,
      );
      return;
    }
    throw new WorkspaceBudgetQuotaExceededError({
      purpose: decision.purpose,
      windowDays: decision.windowDays,
      maxRuns: decision.maxRuns,
      usedRuns: decision.usedRuns,
      maxSpendMicros: decision.maxSpendMicros.toString(),
      usedSpendMicros: decision.usedSpendMicros.toString(),
    });
  }

  async evaluate(
    workspaceId: string,
    purpose: string,
    now: Date = new Date(),
  ): Promise<WorkspaceBudgetDecision> {
    return this.prisma.$transaction(async (tx) => {
      const policy = await tx.workspaceBudgetPolicy.upsert({
        where: { workspaceId },
        create: {
          workspaceId,
          windowDays: this.config.WORKSPACE_QUOTA_WINDOW_DAYS,
          maxRuns: this.config.WORKSPACE_QUOTA_MAX_RUNS,
          maxSpendMicros: BigInt(this.config.WORKSPACE_QUOTA_MAX_SPEND_MICROS),
          enabled: true,
        },
        update: {},
      });
      // 同一 workspace 的签发串行化，避免两个并发请求同时越过上限。
      await tx.$queryRaw`SELECT 1 FROM workspace_budget_policy WHERE workspace_id = ${workspaceId}::uuid FOR UPDATE`;
      const since = new Date(now.getTime() - policy.windowDays * 86_400_000);
      if (!policy.enabled) {
        return {
          allowed: true,
          enforced: false,
          purpose,
          windowDays: policy.windowDays,
          maxRuns: policy.maxRuns,
          usedRuns: null,
          maxSpendMicros: policy.maxSpendMicros,
          usedSpendMicros: 0n,
        };
      }
      const usedRuns =
        purpose === RUN_PURPOSE
          ? await tx.discoveryRunLink.count({
              where: { workspaceId, createdAt: { gte: since } },
            })
          : null;
      const spend = await tx.costLedger.aggregate({
        _sum: { amountMicros: true },
        where: { workspaceId, occurredAt: { gte: since } },
      });
      const usedSpendMicros = BigInt(spend._sum.amountMicros ?? 0);
      const base = {
        enforced: true,
        purpose,
        windowDays: policy.windowDays,
        maxRuns: policy.maxRuns,
        usedRuns,
        maxSpendMicros: policy.maxSpendMicros,
        usedSpendMicros,
      };
      if (usedRuns !== null && usedRuns >= policy.maxRuns) {
        return { allowed: false, reason: 'RUNS', ...base };
      }
      if (usedSpendMicros >= policy.maxSpendMicros) {
        return { allowed: false, reason: 'SPEND', ...base };
      }
      return { allowed: true, ...base };
    });
  }
}

export class WorkspaceBudgetQuotaExceededError extends Error {
  readonly status = 402;
  readonly code = 'WORKSPACE_BUDGET_EXCEEDED';

  constructor(
    readonly details: {
      purpose: string;
      windowDays: number;
      maxRuns: number;
      usedRuns: number | null;
      maxSpendMicros: string;
      usedSpendMicros: string;
    },
  ) {
    super('本月运行额度已用完，请联系运营提升额度');
    this.name = 'WorkspaceBudgetQuotaExceededError';
  }
}

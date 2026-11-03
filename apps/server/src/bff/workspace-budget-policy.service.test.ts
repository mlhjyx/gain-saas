import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import {
  WorkspaceBudgetPolicyService,
  WorkspaceBudgetQuotaExceededError,
} from './workspace-budget-policy.service.js';

const WORKSPACE = '33fe8b32-e417-4355-af91-96fc042d59e0';

function createService(
  options: {
    usedRuns?: number;
    usedSpendMicros?: number;
    policy?: Partial<{
      windowDays: number;
      maxRuns: number;
      maxSpendMicros: bigint;
      enabled: boolean;
    }>;
    enforce?: boolean;
  } = {},
) {
  const upsert = vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
    workspaceId: WORKSPACE,
    windowDays: 30,
    maxRuns: 30,
    maxSpendMicros: 15_000_000n,
    enabled: true,
    ...create,
    ...options.policy,
  }));
  const count = vi.fn(async () => options.usedRuns ?? 0);
  const aggregate = vi.fn(async () => ({
    _sum: { amountMicros: options.usedSpendMicros ?? 0 },
  }));
  const tx = {
    workspaceBudgetPolicy: { upsert },
    $queryRaw: vi.fn(async () => [{ lock: 1 }]),
    discoveryRunLink: { count },
    costLedger: { aggregate },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const config = {
    WORKSPACE_QUOTA_ENFORCE: options.enforce ?? true,
    WORKSPACE_QUOTA_WINDOW_DAYS: 30,
    WORKSPACE_QUOTA_MAX_RUNS: 30,
    WORKSPACE_QUOTA_MAX_SPEND_MICROS: 15_000_000,
  } as AppConfig;
  const service = new WorkspaceBudgetPolicyService(config, prisma);
  return { service, upsert, count, aggregate, lock: tx.$queryRaw };
}

describe('WorkspaceBudgetPolicyService', () => {
  it('discovery.run 达到 run 上限时拒绝', async () => {
    const { service } = createService({ usedRuns: 30 });
    const decision = await service.evaluate(WORKSPACE, 'discovery.run');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('RUNS');
    expect(decision.usedRuns).toBe(30);
    expect(decision.windowDays).toBe(30);
  });

  it('未达上限时放行', async () => {
    const { service } = createService({ usedRuns: 29 });
    const decision = await service.evaluate(WORKSPACE, 'discovery.run');
    expect(decision.allowed).toBe(true);
  });

  it('花费达到上限时拒绝所有 purpose', async () => {
    const { service } = createService({ usedSpendMicros: 15_000_000 });
    const decision = await service.evaluate(WORKSPACE, 'understanding.run');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('SPEND');
    expect(decision.usedRuns).toBeNull();
  });

  it('非 discovery.run 的 purpose 不统计 run 次数', async () => {
    const { service, count } = createService({ usedRuns: 999 });
    const decision = await service.evaluate(WORKSPACE, 'icp.design');
    expect(decision.allowed).toBe(true);
    expect(count).not.toHaveBeenCalled();
  });

  it('policy 关闭（存量豁免）时全部放行', async () => {
    const { service } = createService({
      policy: { enabled: false },
      usedRuns: 999,
      usedSpendMicros: 999_999_999,
    });
    const decision = await service.evaluate(WORKSPACE, 'discovery.run');
    expect(decision.allowed).toBe(true);
    expect(decision.enforced).toBe(false);
  });

  it('懒创建用配置默认值并锁行', async () => {
    const { service, upsert, lock } = createService();
    await service.evaluate(WORKSPACE, 'discovery.run');
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WORKSPACE },
        create: expect.objectContaining({
          workspaceId: WORKSPACE,
          windowDays: 30,
          maxRuns: 30,
          maxSpendMicros: 15_000_000n,
          enabled: true,
        }),
      }),
    );
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('assertGrantAllowed 超限抛 402 且带明细', async () => {
    const { service } = createService({ usedRuns: 30 });
    const error = await service
      .assertGrantAllowed(WORKSPACE, 'discovery.run')
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(WorkspaceBudgetQuotaExceededError);
    const quotaError = error as WorkspaceBudgetQuotaExceededError;
    expect(quotaError.status).toBe(402);
    expect(quotaError.code).toBe('WORKSPACE_BUDGET_EXCEEDED');
    expect(quotaError.details).toMatchObject({
      purpose: 'discovery.run',
      windowDays: 30,
      maxRuns: 30,
      usedRuns: 30,
    });
    expect(quotaError.message).toContain('额度');
  });

  it('enforce=false 时只记录不拒绝', async () => {
    const { service } = createService({ usedRuns: 30, enforce: false });
    await expect(service.assertGrantAllowed(WORKSPACE, 'discovery.run')).resolves.toBeUndefined();
  });
});

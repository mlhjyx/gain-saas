import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import type { AuditService } from '../shared/audit.service.js';
import {
  PlatformPolicyDenied,
  PlatformPolicyStateService,
} from './platform-policy-state.service.js';
import type { PlatformRevocationService } from './platform-revocation.service.js';

function fixture(modes: Record<string, string>, overrides: Partial<AppConfig> = {}) {
  const config = {
    R4_PLATFORM_POLICY_MODES: JSON.stringify(modes),
    ...overrides,
  } as unknown as AppConfig;
  const findUnique = vi.fn().mockResolvedValue(null);
  const create = vi.fn().mockResolvedValue({});
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const findFirst = vi.fn().mockResolvedValue(null);
  const findMany = vi.fn().mockResolvedValue([]);
  const prisma = {
    r4PlatformPolicyState: { findUnique, create, updateMany, findMany },
    r4RevocationRequest: { findFirst },
  } as unknown as PrismaService;
  const revocations = { create: vi.fn().mockResolvedValue({ id: 'req' }) } as unknown as PlatformRevocationService;
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return {
    service: new PlatformPolicyStateService(config, prisma, revocations, audit),
    findUnique, create, updateMany, findFirst, revocations, audit,
  };
}

const ALL_ENABLED = {
  'acq-sweep': 'ENABLED',
  'intent-sweep': 'ENABLED',
  'sanctions-refresh': 'ENABLED',
};

describe('平台策略状态', () => {
  it('配置只允许三个有 egress 的 schedule，缺一/多一/坏值都拒绝', () => {
    expect(fixture(ALL_ENABLED).service.configuredModes()).toHaveLength(3);
    expect(() => fixture({ ...ALL_ENABLED, 'patents-cache-refresh': 'ENABLED' }).service.configuredModes())
      .toThrow(/只能包含三个/);
    expect(() => fixture({ 'acq-sweep': 'ENABLED' }).service.configuredModes()).toThrow(/只能包含三个/);
    expect(() => fixture({ ...ALL_ENABLED, 'acq-sweep': 'PAUSED' }).service.configuredModes())
      .toThrow(/ENABLED 或 DISABLED/);
  });

  it('首次同步只建立基线，不产生撤销请求', async () => {
    const { service, create, revocations } = fixture(ALL_ENABLED);
    await service.sync();
    expect(create).toHaveBeenCalledTimes(3);
    expect(revocations.create).not.toHaveBeenCalled();
  });

  it('ENABLED→DISABLED 产生一次 POLICY_DISABLED 请求；重复同步不重复产生', async () => {
    const { service, findUnique, updateMany, revocations } = fixture({ ...ALL_ENABLED, 'acq-sweep': 'DISABLED' });
    findUnique
      .mockResolvedValueOnce({ scheduleId: 'acq-sweep', mode: 'ENABLED' })
      .mockResolvedValueOnce({ scheduleId: 'intent-sweep', mode: 'ENABLED' })
      .mockResolvedValueOnce({ scheduleId: 'sanctions-refresh', mode: 'ENABLED' });
    await service.sync();
    expect(updateMany).toHaveBeenCalledWith({
      where: { scheduleId: 'acq-sweep', mode: 'ENABLED' },
      data: { mode: 'DISABLED', updatedBy: 'policy-config' },
    });
    expect(revocations.create).toHaveBeenCalledWith(expect.objectContaining({
      scheduleId: 'acq-sweep',
      reasonCode: 'POLICY_DISABLED',
      source: 'POLICY_STATE',
    }));

    // 第二次同步：状态已经是 DISABLED，不再产生请求。
    findUnique.mockReset();
    findUnique.mockResolvedValue({ scheduleId: 'acq-sweep', mode: 'DISABLED' });
    await service.sync();
    expect(revocations.create).toHaveBeenCalledTimes(1);
  });

  it('DISABLED→ENABLED 只记录，不重开围栏、不产生请求', async () => {
    const { service, findUnique, updateMany, revocations, audit } = fixture(ALL_ENABLED);
    findUnique.mockImplementation(async ({ where }: { where: { scheduleId: string } }) => ({
      scheduleId: where.scheduleId,
      mode: where.scheduleId === 'acq-sweep' ? 'DISABLED' : 'ENABLED',
    }));
    await service.sync();
    expect(updateMany).toHaveBeenCalledWith({
      where: { scheduleId: 'acq-sweep', mode: 'DISABLED' },
      data: { mode: 'ENABLED', updatedBy: 'policy-config' },
    });
    expect(revocations.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'r4.policy-state.transition', target: 'acq-sweep',
    }));
  });

  it('策略 DISABLED 时拒绝签发 Grant', async () => {
    const { service, findUnique } = fixture(ALL_ENABLED);
    findUnique.mockResolvedValue({ scheduleId: 'acq-sweep', mode: 'DISABLED' });
    await expect(service.assertIssuable('acq-sweep')).rejects.toBeInstanceOf(PlatformPolicyDenied);
    await expect(service.assertIssuable('acq-sweep')).rejects.toMatchObject({
      code: 'PLATFORM_GRANT_POLICY_DISABLED',
    });
  });

  it('有未结撤销请求时也拒绝签发 Grant', async () => {
    const { service, findUnique, findFirst } = fixture(ALL_ENABLED);
    findUnique.mockResolvedValue({ scheduleId: 'acq-sweep', mode: 'ENABLED' });
    findFirst.mockResolvedValue({ id: 'req', state: 'PENDING_CONFIRMATION' });
    await expect(service.assertIssuable('acq-sweep')).rejects.toMatchObject({
      code: 'PLATFORM_GRANT_REVOCATION_PENDING',
    });
  });
});

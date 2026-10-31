import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import type { AuditService } from '../shared/audit.service.js';
import {
  PlatformRevocationService,
  REVOCATION_SOURCES,
} from './platform-revocation.service.js';

const NOW = 1_793_600_000_000;
const REQUEST_ID = '2b7f4c1e-9a3d-4f5b-8c6e-1d2a3b4c5d6e';

function fixture(overrides: Partial<AppConfig> = {}) {
  const config = {
    R4_REVOCATION_AUTO_CONFIRM: false,
    ...overrides,
  } as unknown as AppConfig;
  const findUnique = vi.fn().mockResolvedValue(null);
  const findFirst = vi.fn().mockResolvedValue(null);
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: REQUEST_ID, createdAt: new Date(NOW), updatedAt: new Date(NOW), ...data,
  }));
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const queryRaw = vi.fn().mockResolvedValue([{ next_value: 7n }]);
  const txRequestUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const txAttemptUpdate = vi.fn().mockResolvedValue({});
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      r4RevocationRequest: { updateMany: txRequestUpdateMany },
      r4RevocationAttempt: { update: txAttemptUpdate },
    }));
  const prisma = {
    r4RevocationRequest: { findUnique, findFirst, create, updateMany },
    $queryRaw: queryRaw,
    $transaction: transaction,
  } as unknown as PrismaService;
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return {
    service: new PlatformRevocationService(config, prisma, audit),
    findUnique, findFirst, create, updateMany, queryRaw,
    txRequestUpdateMany, txAttemptUpdate, audit,
  };
}

const input = (overrides: Record<string, unknown> = {}) => ({
  scheduleId: 'acq-sweep',
  reasonCode: 'OPERATOR_HOLD' as const,
  source: 'OPERATOR' as const,
  requestedBy: 'ops@example.com',
  ...overrides,
});

describe('撤销逻辑请求', () => {
  it('操作员发起的请求立即进入 PENDING，并分配持久序列号', async () => {
    const { service, create, queryRaw, audit } = fixture();
    const created = await service.create(input({ note: '紧急停机' }));
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scheduleId: 'acq-sweep',
        reasonCode: 'OPERATOR_HOLD',
        source: 'OPERATOR',
        state: 'PENDING',
        fenceSequence: 7n,
        note: '紧急停机',
      }),
    });
    expect(created.id).toBe(REQUEST_ID);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'r4.revocation.requested' }));
  });

  it('自动来源在受审计重开路径就绪前停在 PENDING_CONFIRMATION', async () => {
    const { service, create } = fixture();
    await service.create(input({ source: 'POLICY_STATE', reasonCode: 'POLICY_DISABLED', requestedBy: 'policy-config' }));
    expect(create.mock.calls[0]![0].data.state).toBe('PENDING_CONFIRMATION');
  });

  it('R4_REVOCATION_AUTO_CONFIRM=true 时自动来源也直接投递', async () => {
    const { service, create } = fixture({ R4_REVOCATION_AUTO_CONFIRM: true });
    await service.create(input({ source: 'BINDING_REVOKED', reasonCode: 'SECURITY_RESPONSE', requestedBy: 'binding:ops' }));
    expect(create.mock.calls[0]![0].data.state).toBe('PENDING');
  });

  it('同一 schedule 的未结请求幂等返回，不再分配新号', async () => {
    const { service, findFirst, queryRaw } = fixture();
    findFirst.mockResolvedValue({ id: 'existing', state: 'PENDING' });
    const result = await service.create(input());
    expect(result.id).toBe('existing');
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('dedupeKey 命中时直接返回已有请求', async () => {
    const { service, findUnique, queryRaw } = fixture();
    findUnique.mockResolvedValue({ id: 'existing', state: 'ACKED' });
    const result = await service.create(input({ dedupeKey: 'binding-revoked:acq-sweep:2026-11-01' }));
    expect(result.id).toBe('existing');
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('没有 egress 的 schedule 不能撤销；未知来源/原因码被拒绝', async () => {
    const { service } = fixture();
    await expect(service.create(input({ scheduleId: 'patents-cache-refresh' }))).rejects.toThrow(/没有 egress/);
    await expect(service.create(input({ reasonCode: 'NOPE' }))).rejects.toThrow(/reason_code/);
    await expect(service.create(input({ source: 'NOPE' }))).rejects.toThrow(/来源/);
    expect(REVOCATION_SOURCES).toContain('OPERATOR');
  });

  it('确认只允许 PENDING_CONFIRMATION → PENDING，并可重复读回', async () => {
    const { service, updateMany, findUnique } = fixture();
    findUnique.mockResolvedValue({ id: REQUEST_ID, state: 'PENDING', scheduleId: 'acq-sweep', fenceSequence: 3n });
    const result = await service.confirm(REQUEST_ID, 'ops@example.com');
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: REQUEST_ID, state: 'PENDING_CONFIRMATION' },
      data: expect.objectContaining({ state: 'PENDING', confirmedBy: 'ops@example.com' }),
    });
    expect(result.state).toBe('PENDING');
  });

  it('取消只允许未投递或已确定未提交的状态', async () => {
    const { service, updateMany, findUnique } = fixture();
    updateMany.mockResolvedValue({ count: 0 });
    findUnique.mockResolvedValue({ id: REQUEST_ID, state: 'PENDING', scheduleId: 'acq-sweep' });
    await expect(service.cancel(REQUEST_ID, 'ops@example.com', '配置修复后重来'))
      .rejects.toThrow(/不能取消/);
  });

  it('ACK 落库要求请求与尝试同事务更新', async () => {
    const { service, txRequestUpdateMany, txAttemptUpdate } = fixture();
    await service.markAcked(REQUEST_ID, 'attempt-1', {
      receiptId: '7f1d2c3b-4a59-4e6f-8d7c-1b2a3c4d5e6f',
      generation: '2',
      committedAt: Math.floor(NOW / 1000),
      inFlightAttempts: '0',
      ackSha256: 'a'.repeat(64),
    });
    expect(txRequestUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: REQUEST_ID, state: 'PENDING' },
      data: expect.objectContaining({ state: 'ACKED', ackGeneration: 2n, ackInFlightAttempts: 0n }),
    }));
    expect(txAttemptUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ outcome: 'ACKED' }),
    }));
  });

  it('非法 ACK 事实被拒绝（不写库）', async () => {
    const { service, txRequestUpdateMany } = fixture();
    await expect(service.markAcked(REQUEST_ID, 'attempt-1', {
      receiptId: 'not-a-uuid', generation: '2', committedAt: 1, inFlightAttempts: '0', ackSha256: 'a'.repeat(64),
    })).rejects.toThrow(/ACK 事实/);
    expect(txRequestUpdateMany).not.toHaveBeenCalled();
  });
});

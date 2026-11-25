import { describe, expect, it, vi } from 'vitest';
import { AuditService } from './audit.service.js';

const WS_ID = '11111111-1111-4111-8111-111111111111';

describe('AuditService', () => {
  it('persists workspaceId when provided', async () => {
    const create = vi.fn(async () => ({ id: 'a-1' }));
    const service = new AuditService({ auditLog: { create } } as never);

    await service.record({
      realm: 'tenant',
      actorId: 'u-1',
      workspaceId: WS_ID,
      action: 'campaign.created',
      target: 'campaign/c-1',
      detail: { foo: 'bar' },
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        realm: 'tenant',
        actorId: 'u-1',
        workspaceId: WS_ID,
        action: 'campaign.created',
        target: 'campaign/c-1',
        detail: { foo: 'bar' },
      },
    });
  });

  it('persists null when workspaceId is explicitly null and omits when undefined', async () => {
    const create = vi.fn(async () => ({ id: 'a-1' }));
    const service = new AuditService({ auditLog: { create } } as never);

    await service.record({
      realm: 'ops',
      actorId: 'ops-1',
      workspaceId: null,
      action: 'ops.login',
    });
    expect(create).toHaveBeenNthCalledWith(1, {
      data: {
        realm: 'ops',
        actorId: 'ops-1',
        workspaceId: null,
        action: 'ops.login',
        target: undefined,
        detail: undefined,
      },
    });

    await service.record({
      realm: 'ops',
      actorId: 'ops-1',
      action: 'schedule.pause',
      target: 'sched-1',
    });
    const secondCallData = (create.mock.calls[1]![0] as { data: Record<string, unknown> }).data;
    expect('workspaceId' in secondCallData).toBe(false);
  });

  it('swallows persistence errors so audit never blocks business flow', async () => {
    const create = vi.fn(async () => {
      throw new Error('db down');
    });
    const service = new AuditService({ auditLog: { create } } as never);

    await expect(
      service.record({
        realm: 'tenant',
        actorId: 'u-1',
        workspaceId: WS_ID,
        action: 'auth.logout',
      }),
    ).resolves.toBeUndefined();
  });
});

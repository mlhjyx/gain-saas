import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { OpsController } from './ops.controller.js';
import { OpsExportThrottle } from './ops-export-throttle.js';
import { OpsService } from './ops.service.js';

const WS_ID = '11111111-1111-4111-8111-111111111111';

function makeService(rows: Array<Record<string, unknown>> = []) {
  const findMany = vi.fn(async () =>
    rows.map((row) => ({
      id: 'audit-1',
      realm: 'ops',
      actorId: 'ops-1',
      workspaceId: null,
      action: 'ops.login',
      target: null,
      detail: null,
      at: new Date('2026-11-25T10:00:00Z'),
      ...row,
    })),
  );
  const service = new OpsService(
    { OPS_EXPORT_HOURLY_LIMIT: 10 } as AppConfig,
    {} as never,
    {} as never,
    { record: vi.fn(async () => undefined) } as never,
    { auditLog: { findMany } } as never,
    new OpsExportThrottle(10),
  );
  const controller = new OpsController(service, {} as never, {} as never);
  return { service, controller, findMany };
}

describe('OpsController.audit & OpsService.auditLog', () => {
  it('defaults to realm=ops when neither workspaceId nor realm is provided', async () => {
    const { controller, findMany } = makeService([{ id: 'a-1' }]);

    const res = await controller.audit();

    expect(findMany).toHaveBeenCalledWith({
      where: { realm: 'ops' },
      orderBy: { at: 'desc' },
      take: 100,
    });
    expect(res.entries[0]!.at).toBe('2026-11-25T10:00:00.000Z');
  });

  it('filters by workspaceId across all realms when workspaceId is given without realm', async () => {
    const { controller, findMany } = makeService();

    await controller.audit('50', WS_ID);

    expect(findMany).toHaveBeenCalledWith({
      where: { workspaceId: WS_ID },
      orderBy: { at: 'desc' },
      take: 50,
    });
  });

  it('filters by both realm and workspaceId when both are provided', async () => {
    const { controller, findMany } = makeService();

    await controller.audit('25', WS_ID, 'tenant');

    expect(findMany).toHaveBeenCalledWith({
      where: { realm: 'tenant', workspaceId: WS_ID },
      orderBy: { at: 'desc' },
      take: 25,
    });
  });

  it('rejects non-UUID workspaceId with 400 BadRequestException', async () => {
    const { controller, findMany } = makeService();

    await expect(controller.audit('50', 'not-a-uuid')).rejects.toBeInstanceOf(BadRequestException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('rejects invalid realm with 400 BadRequestException', async () => {
    const { controller, findMany } = makeService();

    await expect(controller.audit('50', WS_ID, 'admin')).rejects.toBeInstanceOf(BadRequestException);
    expect(findMany).not.toHaveBeenCalled();
  });
});

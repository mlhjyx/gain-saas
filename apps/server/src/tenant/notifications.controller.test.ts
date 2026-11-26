import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import { NotificationsController } from './notifications.controller.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const FOREIGN_WORKSPACE = '22222222-2222-4222-8222-222222222222';
const req = { tenant: { workspaceId: WORKSPACE } } as never;

function fixture(mode: AppConfig['LEGACY_EXECUTION_BUDGET_MODE'], enforce: boolean) {
  const rows = [
    { id: 'warning', type: 'WorkspaceQuotaWarning', workspaceId: WORKSPACE },
    { id: 'exceeded', type: 'WorkspaceQuotaExceeded', workspaceId: WORKSPACE },
    { id: 'task', type: 'DiscoveryRunCompleted', workspaceId: WORKSPACE },
    { id: 'foreign', type: 'DiscoveryRunCompleted', workspaceId: FOREIGN_WORKSPACE },
  ].map((row) => ({
    ...row,
    refId: null,
    title: row.id,
    titleEn: null,
    readAt: null as Date | null,
    createdAt: new Date('2026-11-26T12:00:00.000Z'),
  }));
  const matching = (where: Prisma.NotificationWhereInput) => {
    const ignoredTypes = typeof where.type === 'object' && Array.isArray(where.type?.notIn)
      ? where.type.notIn
      : [];
    return rows.filter((row) =>
      row.workspaceId === where.workspaceId &&
      !ignoredTypes.includes(row.type) &&
      (where.readAt !== null || row.readAt === null),
    );
  };
  const tx = {
    notification: {
      findMany: vi.fn(async ({ where }: { where: Prisma.NotificationWhereInput }) => matching(where)),
      count: vi.fn(async ({ where }: { where: Prisma.NotificationWhereInput }) => matching(where).length),
      updateMany: vi.fn(async ({ where, data }: { where: Prisma.NotificationWhereInput; data: { readAt: Date } }) => {
        const updated = matching(where);
        for (const row of updated) row.readAt = data.readAt;
        return { count: updated.length };
      }),
    },
  };
  const prisma = { withWorkspace: async (_workspaceId: string, operation: (client: typeof tx) => unknown) => operation(tx) };
  const config = {
    LEGACY_EXECUTION_BUDGET_MODE: mode,
    WORKSPACE_QUOTA_ENFORCE: enforce,
  } as AppConfig;
  const controller = new NotificationsController(prisma as unknown as PrismaService, config);
  return { controller, rows };
}

describe('legacy quota notifications', () => {
  it.each([['bypass', true], ['enforce', false]] as const)(
    'hides old quota alerts from the feed and unread count with mode=%s and enforcement=%s',
    async (mode, enforce) => {
      const { controller } = fixture(mode, enforce);
      const { data } = await controller.list(req);

      expect(data.items.map((item) => item.id)).toEqual(['task']);
      expect(data.unreadCount).toBe(1);
    },
  );

  it('marks only visible notifications as read in bypass mode', async () => {
    const { controller, rows } = fixture('bypass', true);

    await expect(controller.readAll(req)).resolves.toEqual({ data: { updated: 1 } });
    expect(rows.map((row) => [row.id, Boolean(row.readAt)])).toEqual([
      ['warning', false],
      ['exceeded', false],
      ['task', true],
      ['foreign', false],
    ]);
    expect((await controller.list(req)).data.unreadCount).toBe(0);
  });

  it('continues to show alerts when the old workspace quota is enforced', async () => {
    const { controller } = fixture('enforce', true);
    const { data } = await controller.list(req);

    expect(data.items.map((item) => item.id)).toEqual(['warning', 'exceeded', 'task']);
    expect(data.unreadCount).toBe(3);
  });
});

import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';
import { AdminGuard } from '../tenant/admin.guard.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { OutreachReconciliationController } from './outreach-reconciliation.controller.js';
import { OutreachWarmupController } from './outreach-warmup.controller.js';

function mockContext(role: 'admin' | 'member'): ExecutionContext {
  const req = {
    tenant: {
      userId: '11111111-1111-4111-8111-111111111111',
      workspaceId: '22222222-2222-4222-8222-222222222222',
      role,
    },
  };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;
}

describe('Outreach admin-only controllers guard enforcement', () => {
  it.each([
    ['OutreachReconciliationController', OutreachReconciliationController],
    ['OutreachWarmupController', OutreachWarmupController],
  ])('%s mounts both TenantGuard and AdminGuard in order', (_name, ControllerClass) => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ControllerClass) as unknown[] | undefined;
    expect(guards).toEqual([TenantGuard, AdminGuard]);
  });

  it('AdminGuard rejects member with 403 ADMIN_REQUIRED and allows admin', () => {
    const guard = new AdminGuard();

    const memberError = (() => {
      try {
        guard.canActivate(mockContext('member'));
        return null;
      } catch (err) {
        return err;
      }
    })();

    expect(memberError).toBeInstanceOf(ForbiddenException);
    expect((memberError as ForbiddenException).getStatus()).toBe(403);
    expect((memberError as ForbiddenException).getResponse()).toEqual({
      error: { code: 'ADMIN_REQUIRED', message: '该操作需要管理员权限' },
    });

    expect(guard.canActivate(mockContext('admin'))).toBe(true);
  });
});

import { Controller, Get, NotFoundException, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../shared/prisma.service.js';
import { TenantGuard } from './tenant.guard.js';

/**
 * 工作空间上下文(SD11/§10.4)：前端据此渲染角色差异与「允许动作」。
 * 服务端仍是强校验方——allowedActions 只决定界面可见性，不替代任何后端校验。
 */
const ALLOWED_ACTIONS: Record<string, readonly string[]> = {
  admin: [
    'workspace.rename',
    'workspace.leave',
    'members.manage',
    'company.manage',
    'acquisition.run',
    'reports.view',
    'onboarding.complete',
  ],
  member: ['workspace.leave', 'acquisition.run', 'reports.view'],
};

@Controller('api/workspace')
@UseGuards(TenantGuard)
export class WorkspaceContextController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('context')
  async context(@Req() req: Request) {
    const tenant = req.tenant!;
    const [membership, user] = await Promise.all([
      this.prisma.membership.findFirst({
        where: {
          userId: tenant.userId,
          workspaceId: tenant.workspaceId,
          status: 'active',
        },
        include: { workspace: { select: { id: true, name: true } } },
      }),
      this.prisma.user.findUnique({
        where: { id: tenant.userId },
        select: { id: true, email: true },
      }),
    ]);
    if (!membership || !user) {
      throw new NotFoundException({
        error: { code: 'WORKSPACE_CONTEXT_UNAVAILABLE', message: '工作空间或用户不存在' },
      });
    }
    return {
      data: {
        user: { id: user.id, email: user.email },
        workspace: {
          id: membership.workspace.id,
          name: membership.workspace.name,
          role: membership.role,
        },
        onboarding: {
          complete: tenant.onboardingCompleted !== false,
          companyId: tenant.onboardingCompanyId ?? null,
        },
        allowedActions: ALLOWED_ACTIONS[membership.role] ?? [],
      },
    };
  }
}

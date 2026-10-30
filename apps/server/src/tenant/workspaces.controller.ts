import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../shared/prisma.service.js';
import { AuditService } from '../shared/audit.service.js';
import { TenantGuard } from './tenant.guard.js';
import { SESSION_COOKIE, SessionService } from './session.service.js';

/**
 * 工作空间管理(A3/SD2):模型多对多，UI 只做切换、创建、改名、退出。
 * 不做所有权转移和高级空间管理。
 */
@Controller('api/workspaces')
@UseGuards(TenantGuard)
export class WorkspacesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  @Get()
  async list(@Req() req: Request) {
    const tenant = req.tenant!;
    const memberships = await this.prisma.membership.findMany({
      where: { userId: tenant.userId, status: 'active' },
      include: { workspace: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      data: memberships.map((membership) => ({
        id: membership.workspace.id,
        name: membership.workspace.name,
        role: membership.role,
        current: membership.workspaceId === tenant.workspaceId,
      })),
    };
  }

  @Post()
  async create(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const tenant = req.tenant!;
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 128) : '';
    if (!name) throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: '工作空间名称必填' } });
    const workspace = await this.prisma.workspace.create({
      data: {
        id: randomUUID(),
        name,
        memberships: { create: { userId: tenant.userId, role: 'admin' } },
        registry: { create: {} },
      },
    });
    await this.audit.record({ realm: 'tenant', actorId: tenant.userId, action: 'workspaces.create', target: workspace.id, detail: { name } });
    return { data: { id: workspace.id, name: workspace.name, role: 'admin' } };
  }

  @Patch(':workspaceId')
  async rename(@Req() req: Request, @Param('workspaceId') workspaceId: string, @Body() body: Record<string, unknown>) {
    const tenant = req.tenant!;
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 128) : '';
    if (!name) throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: '工作空间名称必填' } });
    const membership = await this.prisma.membership.findFirst({
      where: { userId: tenant.userId, workspaceId, status: 'active' },
    });
    if (!membership) throw new NotFoundException({ error: { code: 'NOT_A_MEMBER', message: '你不属于该工作空间' } });
    if (membership.role !== 'admin') {
      throw new BadRequestException({ error: { code: 'FORBIDDEN', message: '只有管理员可以修改工作空间名称' } });
    }
    const updated = await this.prisma.workspace.update({ where: { id: workspaceId }, data: { name } });
    await this.audit.record({ realm: 'tenant', actorId: tenant.userId, action: 'workspaces.rename', target: workspaceId, detail: { name } });
    return { data: { id: updated.id, name: updated.name } };
  }

  @Post(':workspaceId/leave')
  async leave(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('workspaceId') workspaceId: string) {
    const tenant = req.tenant!;
    const membership = await this.prisma.membership.findFirst({
      where: { userId: tenant.userId, workspaceId, status: 'active' },
    });
    if (!membership) throw new NotFoundException({ error: { code: 'NOT_A_MEMBER', message: '你不属于该工作空间' } });
    const [activeMembers, admins] = await Promise.all([
      this.prisma.membership.count({ where: { workspaceId, status: 'active' } }),
      this.prisma.membership.count({ where: { workspaceId, status: 'active', role: 'admin' } }),
    ]);
    if (activeMembers <= 1) {
      throw new BadRequestException({ error: { code: 'LAST_MEMBER', message: '你是这个工作空间的最后一名成员，不能退出' } });
    }
    if (membership.role === 'admin' && admins <= 1) {
      throw new BadRequestException({ error: { code: 'LAST_ADMIN', message: '工作空间至少需要一名管理员；请先移交管理员角色' } });
    }
    await this.prisma.membership.update({ where: { id: membership.id }, data: { status: 'left' } });
    await this.audit.record({ realm: 'tenant', actorId: tenant.userId, action: 'workspaces.leave', target: workspaceId });
    if (workspaceId === tenant.workspaceId) {
      await this.sessions.revoke(tenant.jti);
      res.clearCookie(SESSION_COOKIE);
      return { data: { left: true, currentWorkspace: true } };
    }
    return { data: { left: true, currentWorkspace: false } };
  }
}

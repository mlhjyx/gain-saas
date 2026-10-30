import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../shared/prisma.service.js';
import { AuthService } from './auth.service.js';
import { AdminGuard } from './admin.guard.js';
import { TenantGuard } from './tenant.guard.js';

/** 成员管理(A4):列表全员可见;邀请/角色变更/移除仅管理员,全量审计。 */
@Controller('api/members')
@UseGuards(TenantGuard)
export class MembersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  async list(@Req() req: Request) {
    const tenant = req.tenant!;
    const memberships = await this.prisma.membership.findMany({
      where: { workspaceId: tenant.workspaceId, status: 'active' },
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const invitations = await this.prisma.invitation.findMany({
      where: { workspaceId: tenant.workspaceId, acceptedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
    });
    return {
      data: {
        members: memberships.map((m) => ({ id: m.id, email: m.user.email, role: m.role, joinedAt: m.createdAt })),
        invitations,
      },
    };
  }

  @Post('invite')
  @UseGuards(AdminGuard)
  async invite(@Body() body: Record<string, unknown>, @Req() req: Request) {
    const tenant = req.tenant!;
    const invitation = await this.auth.createInvitation(tenant.workspaceId, tenant.userId, body);
    // 一期不发邮件(PRD §10):token 仅回给发起邀请的管理员一次,共其线下转达;
    // 后续读取邀请列表时不再回显 token(审计已记录邀请动作本身)。
    return {
      data: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
        token: invitation.token,
        invitePath: `/auth/register?invite=${invitation.token}`,
      },
    };
  }

  @Patch(':membershipId')
  @UseGuards(AdminGuard)
  async changeRole(@Param('membershipId') membershipId: string, @Body() body: { role?: string }, @Req() req: Request) {
    const tenant = req.tenant!;
    if (body.role !== 'admin' && body.role !== 'member') {
      throw new UnauthorizedException({ error: { code: 'VALIDATION_ERROR', message: '角色必须是 admin 或 member' } });
    }
    const membership = await this.prisma.membership.findFirst({
      where: { id: membershipId, workspaceId: tenant.workspaceId, status: 'active' },
    });
    if (!membership) {
      throw new UnauthorizedException({ error: { code: 'NOT_FOUND', message: '成员不存在' } });
    }
    // 工作空间必须保留至少一名管理员
    if (membership.role === 'admin' && body.role === 'member') {
      const admins = await this.prisma.membership.count({ where: { workspaceId: tenant.workspaceId, role: 'admin', status: 'active' } });
      if (admins <= 1) {
        throw new UnauthorizedException({ error: { code: 'LAST_ADMIN', message: '工作空间至少需要一名管理员' } });
      }
    }
    const updated = await this.prisma.membership.update({ where: { id: membershipId }, data: { role: body.role } });
    await this.prisma.auditLog.create({
      data: { realm: 'tenant', actorId: tenant.userId, action: 'members.change_role', target: membershipId, detail: { role: body.role } },
    });
    return { data: { id: updated.id, role: updated.role } };
  }

  @Delete(':membershipId')
  @UseGuards(AdminGuard)
  async remove(@Param('membershipId') membershipId: string, @Req() req: Request) {
    const tenant = req.tenant!;
    const membership = await this.prisma.membership.findFirst({
      where: { id: membershipId, workspaceId: tenant.workspaceId, status: 'active' },
    });
    if (!membership) {
      throw new UnauthorizedException({ error: { code: 'NOT_FOUND', message: '成员不存在' } });
    }
    if (membership.userId === tenant.userId) {
      throw new UnauthorizedException({ error: { code: 'SELF_REMOVAL', message: '不能移除自己;如需退出请联系其他管理员' } });
    }
    if (membership.role === 'admin') {
      const admins = await this.prisma.membership.count({ where: { workspaceId: tenant.workspaceId, role: 'admin', status: 'active' } });
      if (admins <= 1) {
        throw new UnauthorizedException({ error: { code: 'LAST_ADMIN', message: '工作空间至少需要一名管理员' } });
      }
    }
    await this.prisma.membership.update({ where: { id: membershipId }, data: { status: 'removed' } });
    await this.prisma.auditLog.create({
      data: { realm: 'tenant', actorId: tenant.userId, action: 'members.remove', target: membershipId },
    });
    return { data: { ok: true } };
  }
}

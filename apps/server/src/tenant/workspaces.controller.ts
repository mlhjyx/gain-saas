import { BadRequestException, Body, ForbiddenException, GoneException, HttpException, Controller, Get, NotFoundException, Optional, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaService } from '../shared/prisma.service.js';
import { AuditService } from '../shared/audit.service.js';
import { EngineHttp } from '../bff/engine-http.js';
import { TenantGuard } from './tenant.guard.js';
import { SESSION_COOKIE, SessionService } from './session.service.js';

/**
 * 工作空间管理(A3/SD2):一企一空间——空间随企业注册创建，成员经邀请加入；
 * 这里只做列表、改名（联动引擎 PATCH /api/v1/workspace）、退出（创建端点 410 退役）。
 */
@Controller('api/workspaces')
@UseGuards(TenantGuard)
export class WorkspacesController {
  /** workspace.id 是 @db.Uuid:非 UUID 直接打 Prisma 会 500;按 404 处理。 */
  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }


  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    @Optional() private readonly engine?: EngineHttp,
  ) {}

  @Get()
  async list(@Req() req: Request) {
    const tenant = req.tenant!;
    const memberships = await this.prisma.$queryRaw<
      Array<{ workspace_id: string; workspace_name: string; workspace_status: string; role: string }>
    >`SELECT workspace_id, workspace_name, workspace_status, role FROM public.app_list_user_workspaces(${tenant.userId}::uuid)`;
    return {
      data: memberships.map((membership) => ({
        id: membership.workspace_id,
        name: membership.workspace_name,
        role: membership.role,
        current: membership.workspace_id === tenant.workspaceId,
      })),
    };
  }

  @Post()
  async create() {
    // 一企一空间（2026-11-21）：工作空间只在注册新企业时创建，不再开放自助多开。
    // 路由保留但返回 410 Gone（与 PRD/changelog 的「410 退役」一致）；同事加入走邀请（/api/members/invite）。
    throw new GoneException({
      error: { code: 'WORKSPACE_CREATE_RETIRED', message: '工作空间随企业注册创建，同事请通过邀请加入' },
    });
  }

  @Patch(':workspaceId')
  async rename(@Req() req: Request, @Param('workspaceId') workspaceId: string, @Body() body: Record<string, unknown>) {
    if (!this.isUuid(workspaceId)) throw new NotFoundException({ error: { code: 'WORKSPACE_NOT_FOUND', message: '工作空间不存在' } });
    const tenant = req.tenant!;
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 128) : '';
    if (!name) throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: '工作空间名称必填' } });
    await this.prisma.withWorkspace(workspaceId, async (tx) => {
      const membership = await tx.membership.findFirst({
        where: { userId: tenant.userId, workspaceId, status: 'active' },
        include: { workspace: { select: { status: true } } },
      });
      if (!membership) throw new NotFoundException({ error: { code: 'NOT_A_MEMBER', message: '你不属于该工作空间' } });
      if (membership.workspace.status !== 'ACTIVE') {
        throw new ForbiddenException({ error: { code: 'WORKSPACE_DISABLED', message: '该工作空间已停用，请联系运营' } });
      }
      if (membership.role !== 'admin') {
        throw new BadRequestException({ error: { code: 'FORBIDDEN', message: '只有管理员可以修改工作空间名称' } });
      }
    });
    const lang = req.headers?.['accept-language'] as string | undefined;
    let engineSynced = false;
    if (this.engine) {
      let engineRes;
      try {
        engineRes = await this.engine.call(
          { userId: tenant.userId, workspaceId, role: 'admin' },
          'PATCH',
          '/workspace',
          { body: { name } },
        );
      } catch (err) {
        throw new HttpException(
          this.engine.toClientError(
            502,
            { error: { code: 'MODEL_UPSTREAM_UNUSABLE', message: err instanceof Error ? err.message : String(err) } },
            lang,
          ),
          502,
        );
      }
      if (engineRes.status >= 400) {
        throw new HttpException(
          this.engine.toClientError(engineRes.status, engineRes.body, lang),
          this.engine.toClientStatus(engineRes.status, engineRes.body),
        );
      }
      engineSynced = true;
    }
    const updated = await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.workspace.update({ where: { id: workspaceId }, data: { name } }),
    );
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      workspaceId,
      action: 'workspaces.rename',
      target: workspaceId,
      detail: { name, engineSynced },
    });
    return { data: { id: updated.id, name: updated.name } };
  }

  @Post(':workspaceId/leave')
  async leave(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('workspaceId') workspaceId: string) {
    const tenant = req.tenant!;
    if (!this.isUuid(workspaceId)) throw new NotFoundException({ error: { code: 'WORKSPACE_NOT_FOUND', message: '工作空间不存在' } });
    await this.prisma.withWorkspace(workspaceId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('workspace-membership'), hashtext(${workspaceId}))`;
      const membership = await tx.membership.findFirst({
        where: { userId: tenant.userId, workspaceId, status: 'active' },
        include: { workspace: { select: { status: true } } },
      });
      if (!membership) throw new NotFoundException({ error: { code: 'NOT_A_MEMBER', message: '你不属于该工作空间' } });
      if (membership.workspace.status !== 'ACTIVE') {
        throw new ForbiddenException({ error: { code: 'WORKSPACE_DISABLED', message: '该工作空间已停用，请联系运营' } });
      }
      const [activeMembers, admins] = await Promise.all([
        tx.membership.count({ where: { workspaceId, status: 'active' } }),
        tx.membership.count({ where: { workspaceId, status: 'active', role: 'admin' } }),
      ]);
      if (activeMembers <= 1) {
        throw new BadRequestException({ error: { code: 'LAST_MEMBER', message: '你是这个工作空间的最后一名成员，不能退出' } });
      }
      if (membership.role === 'admin' && admins <= 1) {
        throw new BadRequestException({ error: { code: 'LAST_ADMIN', message: '工作空间至少需要一名管理员；请先移交管理员角色' } });
      }
      await tx.membership.update({ where: { id: membership.id }, data: { status: 'left' } });
      await tx.session.updateMany({
        where: {
          realm: 'tenant',
          subjectType: 'user',
          subjectId: tenant.userId,
          workspaceId,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
    });
    await this.audit.record({ realm: 'tenant', actorId: tenant.userId, workspaceId, action: 'workspaces.leave', target: workspaceId });
    if (workspaceId === tenant.workspaceId) {
      await this.sessions.revoke(tenant.jti);
      const clearOpts = this.sessions.clearCookieOptions?.();
      if (clearOpts) res.clearCookie(SESSION_COOKIE, clearOpts);
      else res.clearCookie(SESSION_COOKIE);
      return { data: { left: true, currentWorkspace: true } };
    }
    return { data: { left: true, currentWorkspace: false } };
  }
}

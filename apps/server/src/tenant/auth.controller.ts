import { BadRequestException, Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { SESSION_COOKIE, SessionService } from './session.service.js';
import { AuthThrottleService, THROTTLE_POLICIES } from '../shared/auth-throttle.service.js';
import { TenantGuard, type TenantRequestContext } from './tenant.guard.js';
import { PrismaService } from '../shared/prisma.service.js';

declare module 'express' {
  interface Request {
    tenant?: TenantRequestContext;
  }
}

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    private readonly throttle: AuthThrottleService,
  ) {}

  private setSession(res: Response, session: { token: string; claims: { exp: number } }): void {
    res.cookie(SESSION_COOKIE, session.token, this.sessions.cookieOptions(this.sessions.ttl));
  }

  @Get('registration-policy')
  registrationPolicy() {
    return { data: this.auth.registrationPolicy() };
  }

  @Post('register')
  @HttpCode(200)
  async register(@Body() body: Record<string, unknown>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const throttleKey = `tenant-register:${req.ip ?? 'unknown'}`;
    await this.throttle.check(throttleKey, THROTTLE_POLICIES.tenantRegister);
    await this.throttle.hit(throttleKey, THROTTLE_POLICIES.tenantRegister);
    const result = await this.auth.register(body);
    this.setSession(res, result.session);
    return {
      data: {
        user: { id: result.user.id, email: result.user.email },
        workspace: { id: result.workspace.id, name: result.workspace.name },
        role: 'admin',
      },
    };
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const throttleKey = `tenant-login:${req.ip ?? 'unknown'}:${email}`;
    await this.throttle.check(throttleKey, THROTTLE_POLICIES.tenantLogin);
    try {
      const result = await this.auth.login(body);
      await this.throttle.success(throttleKey);
      this.setSession(res, result.session);
      return {
        data: {
          user: { id: result.user.id, email: result.user.email },
          workspace: { id: result.membership.workspaceId, role: result.membership.role },
        },
      };
    } catch (error) {
      const status = (error as { getStatus?: () => number })?.getStatus?.();
      if (status === 401) await this.throttle.hit(throttleKey, THROTTLE_POLICIES.tenantLogin);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(TenantGuard)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const tenant = req.tenant!;
    await this.auth.logout(tenant.jti, tenant.userId, tenant.workspaceId);
    res.clearCookie(SESSION_COOKIE, this.sessions.clearCookieOptions());
    return { data: { ok: true } };
  }

  @Post('password')
  @HttpCode(200)
  @UseGuards(TenantGuard)
  async changePassword(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const tenant = req.tenant!;
    await this.auth.changePassword(tenant.userId, tenant.jti, body, tenant.workspaceId);
    return { data: { ok: true } };
  }

  @Get('session')
  @UseGuards(TenantGuard)
  async session(@Req() req: Request) {
    const tenant = req.tenant!;
    const [user, memberships] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: tenant.userId } }),
      this.prisma.$queryRaw<
        Array<{ workspace_id: string; workspace_name: string; workspace_status: string; role: string }>
      >`SELECT workspace_id, workspace_name, workspace_status, role FROM public.app_list_user_workspaces(${tenant.userId}::uuid)`,
    ]);
    return {
      data: {
        user: { id: tenant.userId, email: user?.email },
        workspace: { id: tenant.workspaceId, role: tenant.role },
        workspaces: memberships.map((m) => ({ id: m.workspace_id, name: m.workspace_name, role: m.role })),
      },
    };
  }

  @Post('switch-workspace')
  @HttpCode(200)
  @UseGuards(TenantGuard)
  async switchWorkspace(@Body() body: { workspaceId?: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const tenant = req.tenant!;
    if (!body.workspaceId) {
      throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: 'workspaceId 必填' } });
    }
    const session = await this.auth.switchWorkspace(tenant.userId, tenant.jti, body.workspaceId);
    this.setSession(res, session);
    return { data: { workspace: { id: session.claims.workspaceId }, role: session.claims.role } };
  }

  @Post('accept-invite')
  @HttpCode(200)
  async acceptInvite(@Body() body: Record<string, unknown>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const throttleKey = `tenant-accept-invite:${req.ip ?? 'unknown'}`;
    await this.throttle.check(throttleKey, THROTTLE_POLICIES.tenantAcceptInvite);
    await this.throttle.hit(throttleKey, THROTTLE_POLICIES.tenantAcceptInvite);
    const result = await this.auth.acceptInvitation(body);
    this.setSession(res, result.session);
    return {
      data: {
        user: { id: result.user.id, email: result.user.email },
        workspace: { id: result.membership.workspaceId },
        role: result.membership.role,
      },
    };
  }
}

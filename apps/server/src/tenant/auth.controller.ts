import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { SESSION_COOKIE, SessionService } from './session.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
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
    private readonly throttle: LoginThrottleService,
  ) {}

  private setSession(res: Response, session: { token: string; claims: { exp: number } }): void {
    res.cookie(SESSION_COOKIE, session.token, this.sessions.cookieOptions(this.sessions.ttl));
  }

  @Post('register')
  @HttpCode(200)
  async register(@Body() body: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
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
    const throttleKey = `${req.ip ?? 'unknown'}:${email}`;
    this.throttle.check(throttleKey);
    try {
      const result = await this.auth.login(body);
      this.throttle.success(throttleKey);
      this.setSession(res, result.session);
      return {
        data: {
          user: { id: result.user.id, email: result.user.email },
          workspace: { id: result.membership.workspaceId, role: result.membership.role },
        },
      };
    } catch (error) {
      const status = (error as { getStatus?: () => number })?.getStatus?.();
      if (status === 401) this.throttle.fail(throttleKey);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(TenantGuard)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const tenant = req.tenant!;
    await this.auth.logout(tenant.jti, tenant.userId);
    res.clearCookie(SESSION_COOKIE);
    return { data: { ok: true } };
  }

  @Post('password')
  @HttpCode(200)
  @UseGuards(TenantGuard)
  async changePassword(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const tenant = req.tenant!;
    await this.auth.changePassword(tenant.userId, tenant.jti, body);
    return { data: { ok: true } };
  }

  @Get('session')
  @UseGuards(TenantGuard)
  async session(@Req() req: Request) {
    const tenant = req.tenant!;
    const user = await this.prisma.user.findUnique({ where: { id: tenant.userId } });
    const memberships = await this.prisma.membership.findMany({
      where: { userId: tenant.userId, status: 'active' },
      include: { workspace: { select: { id: true, name: true } } },
    });
    return {
      data: {
        user: { id: tenant.userId, email: user?.email },
        workspace: { id: tenant.workspaceId, role: tenant.role },
        workspaces: memberships.map((m) => ({ id: m.workspace.id, name: m.workspace.name, role: m.role })),
      },
    };
  }

  @Post('switch-workspace')
  @HttpCode(200)
  @UseGuards(TenantGuard)
  async switchWorkspace(@Body() body: { workspaceId?: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const tenant = req.tenant!;
    if (!body.workspaceId) {
      return { error: { code: 'VALIDATION_ERROR', message: 'workspaceId 必填' } };
    }
    const session = await this.auth.switchWorkspace(tenant.userId, tenant.jti, body.workspaceId);
    this.setSession(res, session);
    return { data: { workspace: { id: session.claims.workspaceId }, role: session.claims.role } };
  }

  @Post('accept-invite')
  @HttpCode(200)
  async acceptInvite(@Body() body: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
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

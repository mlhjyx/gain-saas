import { BadRequestException, Body, Controller, Get, HttpCode, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as argon2 from 'argon2';
import { PrismaService } from '../shared/prisma.service.js';
import { AuditService } from '../shared/audit.service.js';
import { AuthThrottleService, THROTTLE_POLICIES } from '../shared/auth-throttle.service.js';
import { OpsGuard, type OpsRequest } from './ops.guard.js';
import { OPS_SESSION_COOKIE, OpsSessionService } from './ops-session.service.js';

@Controller('api/ops/auth')
export class OpsAuthController {
  constructor(
    private readonly sessions: OpsSessionService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly throttle: AuthThrottleService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: Record<string, unknown>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) {
      throw new BadRequestException({ error: { code: 'VALIDATION', message: '需要 email 与 password' } });
    }
    const throttleKey = `ops-login:${req.ip ?? 'unknown'}:${email}`;
    await this.throttle.check(throttleKey, THROTTLE_POLICIES.opsLogin);
    const user = await this.prisma.opsUser.findUnique({ where: { email } });
    const ok = user && user.status === 'active' ? await argon2.verify(user.passwordHash, password).catch(() => false) : false;
    if (!user || !ok) {
      await this.throttle.hit(throttleKey, THROTTLE_POLICIES.opsLogin);
      throw new UnauthorizedException({ error: { code: 'OPS_BAD_CREDENTIALS', message: '邮箱或密码错误' } });
    }
    await this.throttle.success(throttleKey);
    const { token } = await this.sessions.issue(user.id);
    res.cookie(OPS_SESSION_COOKIE, token, this.sessions.cookieOptions(this.sessions.ttlSecondsValue));
    await this.audit.record({ realm: 'ops', actorId: user.id, action: 'ops.login', target: user.email });
    return { data: { user: { id: user.id, email: user.email } } };
  }

  @Get('session')
  @UseGuards(OpsGuard)
  session(@Req() req: OpsRequest) {
    return { data: { user: req.opsUser } };
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(OpsGuard)
  async logout(@Req() req: OpsRequest, @Res({ passthrough: true }) res: Response) {
    const claims = await this.sessions.verify(req.cookies?.[OPS_SESSION_COOKIE]);
    if (claims) await this.sessions.revoke(claims.jti);
    res.clearCookie(OPS_SESSION_COOKIE, { path: '/' });
    if (req.opsUser) await this.audit.record({ realm: 'ops', actorId: req.opsUser.id, action: 'ops.logout', target: req.opsUser.email });
    return { data: { ok: true } };
  }
}

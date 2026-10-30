import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { OPS_SESSION_COOKIE, OpsSessionService } from './ops-session.service.js';
import { PrismaService } from '../shared/prisma.service.js';

export interface OpsRequest extends Request {
  opsUser?: { id: string; email: string };
}

@Injectable()
export class OpsGuard implements CanActivate {
  constructor(
    private readonly sessions: OpsSessionService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<OpsRequest>();
    const claims = await this.sessions.verify(request.cookies?.[OPS_SESSION_COOKIE]);
    if (!claims) {
      throw new UnauthorizedException({ error: { code: 'OPS_AUTH_REQUIRED', message: '请先登录运营台' } });
    }
    const user = await this.prisma.opsUser.findUnique({ where: { id: claims.opsUserId } });
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException({ error: { code: 'OPS_AUTH_REQUIRED', message: '运营账号不可用' } });
    }
    request.opsUser = { id: user.id, email: user.email };
    return true;
  }
}

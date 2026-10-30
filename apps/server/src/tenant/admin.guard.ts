import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

/** 管理员守卫(挂在 TenantGuard 之后):认领审批、制裁复核、成员管理、导出等。 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    if (req.tenant?.role !== 'admin') {
      throw new ForbiddenException({ error: { code: 'ADMIN_REQUIRED', message: '该操作需要管理员权限' } });
    }
    return true;
  }
}

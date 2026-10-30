import { Module } from '@nestjs/common';
import { ConfigModule } from '../shared/config.module.js';
import { PrismaService } from '../shared/prisma.service.js';
import { AuditService } from '../shared/audit.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuditController } from './audit.controller.js';
import { MembersController } from './members.controller.js';
import { DiscoveryRunsController } from './discovery-runs.controller.js';
import { NotificationsController } from './notifications.controller.js';
import { WorkspacesController } from './workspaces.controller.js';
import { AdminGuard } from './admin.guard.js';
import { TenantGuard } from './tenant.guard.js';
import { SessionService } from './session.service.js';
import { LoginThrottleService } from './login-throttle.service.js';

/**
 * 租户域:认证、成员、BFF(代理与业务控制器挂同一守卫链)。
 * TenantGuard → (AdminGuard) 是租户域唯一入口链;引擎 JWT 只在服务端铸造(SD7)。
 */
@Module({
  imports: [ConfigModule],
  controllers: [AuthController, MembersController, AuditController, DiscoveryRunsController, NotificationsController, WorkspacesController],
  providers: [AuthService, SessionService, TenantGuard, AdminGuard, PrismaService, AuditService, LoginThrottleService],
  exports: [TenantGuard, AdminGuard, SessionService, PrismaService, AuditService],
})
export class TenantModule {}

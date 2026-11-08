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
import { ClaimDraftsController } from './claim-drafts.controller.js';
import { RunTraceController } from './run-trace.controller.js';
import { QgoController } from '../qgo/qgo.controller.js';
import { SaoController } from '../qgo/sao.controller.js';
import { QgoService } from '../qgo/qgo.service.js';
import { WorkspacesController } from './workspaces.controller.js';
import { WorkspaceContextController } from './workspace-context.controller.js';
import { AdminGuard } from './admin.guard.js';
import { TenantGuard } from './tenant.guard.js';
import { SessionService } from './session.service.js';
import { AuthThrottleService } from '../shared/auth-throttle.service.js';
import { EngineHttp } from '../bff/engine-http.js';
import { ServiceModule } from '../service/service.module.js';

/**
 * 租户域:认证、成员、BFF(代理与业务控制器挂同一守卫链)。
 * TenantGuard → (AdminGuard) 是租户域唯一入口链;引擎 JWT 只在服务端铸造(SD7)。
 * EngineHttp 在此自持一份实例(无状态):ClaimDraftsController 需要代理引擎,
 * 而 BffModule 依赖本模块,不能反向导入。
 */
@Module({
  imports: [ConfigModule, ServiceModule],
  controllers: [AuthController, MembersController, AuditController, DiscoveryRunsController, NotificationsController, ClaimDraftsController, RunTraceController, QgoController, SaoController, WorkspacesController, WorkspaceContextController],
  providers: [AuthService, SessionService, TenantGuard, AdminGuard, PrismaService, AuditService, AuthThrottleService, EngineHttp, QgoService],
  exports: [TenantGuard, AdminGuard, SessionService, PrismaService, AuditService, EngineHttp],
})
export class TenantModule {}

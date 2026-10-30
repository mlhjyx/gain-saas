import { Module } from '@nestjs/common';
import { ConfigModule } from '../shared/config.module.js';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import { OpsAuthController } from './ops-auth.controller.js';
import { OpsController } from './ops.controller.js';
import { OpsDatabase } from './ops-database.service.js';
import { OpsGuard } from './ops.guard.js';
import { OpsService } from './ops.service.js';
import { OpsSessionService } from './ops-session.service.js';
import { OpsTemporalService } from './ops-temporal.service.js';
import { OpsModelGatewayController } from './ops-model-gateway.controller.js';
import { ModelGatewayModule } from '../model-gateway/model-gateway.module.js';

/**
 * 运营域(SD9 / PRD §13):独立登录域 + 引擎库 app/owner 双池 + 白名单写。
 * 与租户域互不可调:ops cookie/realm 独立;tenant session 不能进 /api/ops。
 */
@Module({
  imports: [ConfigModule, ModelGatewayModule],
  controllers: [OpsAuthController, OpsController, OpsModelGatewayController],
  providers: [OpsDatabase, OpsService, OpsSessionService, OpsGuard, OpsTemporalService, AuditService, PrismaService],
})
export class OpsModule {}

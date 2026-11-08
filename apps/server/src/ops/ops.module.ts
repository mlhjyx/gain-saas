import { Module } from '@nestjs/common';
import { ConfigModule } from '../shared/config.module.js';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import { AuthThrottleService } from '../shared/auth-throttle.service.js';
import { OpsAttributionController } from './ops-attribution.controller.js';
import { OpsAttributionService } from './ops-attribution.service.js';
import { OpsAuthController } from './ops-auth.controller.js';
import { OpsController } from './ops.controller.js';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { OpsDatabase } from './ops-database.service.js';
import { OpsExportThrottle } from './ops-export-throttle.js';
import { OpsGuard } from './ops.guard.js';
import { OpsService } from './ops.service.js';
import { OpsSessionService } from './ops-session.service.js';
import { OpsTemporalService } from './ops-temporal.service.js';
import { OpsRevocationController } from './ops-revocation.controller.js';
import { R4Module } from '../r4/r4.module.js';
import { ServiceModule } from '../service/service.module.js';
import { OpsChannelsService } from './ops-channels.service.js';
import { OpsEngineClient } from './ops-engine.client.js';

/**
 * 运营域(SD9 / PRD §13):独立登录域 + 引擎库 app/owner 双池 + 白名单写。
 * 与租户域互不可调:ops cookie/realm 独立;tenant session 不能进 /api/ops。
 * P9 起承载平台撤销的运营接口（复用 R4Module 的撤销服务）。
 */
@Module({
  imports: [ConfigModule, R4Module, ServiceModule],
  controllers: [
    OpsAuthController,
    OpsController,
    OpsRevocationController,
    OpsAttributionController,
  ],
  providers: [
    OpsDatabase,
    OpsService,
    OpsAttributionService,
    OpsSessionService,
    OpsGuard,
    OpsTemporalService,
    OpsEngineClient,
    OpsChannelsService,
    AuditService,
    PrismaService,
    AuthThrottleService,
    {
      provide: OpsExportThrottle,
      useFactory: (config: AppConfig) => new OpsExportThrottle(config.OPS_EXPORT_HOURLY_LIMIT),
      inject: [APP_CONFIG],
    },
  ],
})
export class OpsModule {}

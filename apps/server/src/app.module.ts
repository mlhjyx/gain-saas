import { Module } from '@nestjs/common';
import { ConfigModule } from './shared/config.module.js';
import { HealthController } from './health/health.controller.js';
import { PrismaService } from './shared/prisma.service.js';
import { TenantModule } from './tenant/tenant.module.js';
import { OpsModule } from './ops/ops.module.js';
import { ServiceModule } from './service/service.module.js';
import { BffModule } from './bff/bff.module.js';
import { ModelGatewayModule } from './model-gateway/model-gateway.module.js';
import { R4Module } from './r4/r4.module.js';

/**
 * 三域单服务(技术方案 §1/SD9):
 * - TenantModule:租户域(admin/member),承载认证/成员;
 * - BffModule:租户域 BFF 代理(SD7 路由表);
 * - OpsModule:运营域(operator),PG 白名单 + Temporal 集成面,M5 起承载;
 * - ServiceModule:服务域(JWKS 签发、事件消费)。
 * 三个登录域/三条 guard 链在这里汇聚,边界负向测试对应 PRD E1。
 */
@Module({
  imports: [ConfigModule, TenantModule, OpsModule, ServiceModule, BffModule, ModelGatewayModule, R4Module],
  controllers: [HealthController],
  providers: [PrismaService],
})
export class AppModule {}

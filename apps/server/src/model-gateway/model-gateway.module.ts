import { Module } from '@nestjs/common';
import { ConfigModule } from '../shared/config.module.js';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import { ModelGatewayAuthGuard } from './model-gateway-auth.guard.js';
import { ModelGatewayRuntimeController } from './model-gateway-runtime.controller.js';
import { ModelGatewayService } from './model-gateway.service.js';

@Module({
  imports: [ConfigModule],
  controllers: [ModelGatewayRuntimeController],
  providers: [ModelGatewayService, ModelGatewayAuthGuard, PrismaService, AuditService],
  exports: [ModelGatewayService],
})
export class ModelGatewayModule {}

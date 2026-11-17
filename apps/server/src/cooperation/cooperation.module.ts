import { Module } from '@nestjs/common';
import { ConfigModule } from '../shared/config.module.js';
import { AuditService } from '../shared/audit.service.js';
import { AuthThrottleService } from '../shared/auth-throttle.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import { CooperationIntentController } from './cooperation.controller.js';
import { CooperationIntentService } from './cooperation.service.js';

@Module({
  imports: [ConfigModule],
  controllers: [CooperationIntentController],
  providers: [CooperationIntentService, PrismaService, AuthThrottleService, AuditService],
})
export class CooperationModule {}

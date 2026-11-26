import { forwardRef, Module } from '@nestjs/common';
import { AuditService } from '../shared/audit.service.js';
import { ConfigModule } from '../shared/config.module.js';
import { PrismaService } from '../shared/prisma.service.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { WalletHoldSweeperService } from './wallet-hold-sweeper.service.js';
import { WalletController } from './wallet.controller.js';
import { WalletService } from './wallet.service.js';

@Module({
  imports: [ConfigModule, forwardRef(() => TenantModule)],
  controllers: [WalletController],
  providers: [WalletService, WalletHoldSweeperService, PrismaService, AuditService],
  exports: [WalletService],
})
export class WalletModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from '../shared/config.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { CampaignController } from './campaign.controller.js';
import { CampaignInternalController, CampaignServiceTokenGuard } from './campaign-internal.controller.js';
import { CampaignService } from './campaign.service.js';
import { CampaignTokenSigner } from './campaign-token.signer.js';

/**
 * M2.0 Campaign 控制面（docs/technical/campaign-control-plane-m2-0.md）。
 * TenantGuard/AdminGuard/PrismaService/AuditService 由 TenantModule 导出。
 */
@Module({
  imports: [ConfigModule, TenantModule],
  controllers: [CampaignController, CampaignInternalController],
  providers: [CampaignService, CampaignTokenSigner, CampaignServiceTokenGuard],
  exports: [CampaignService],
})
export class CampaignModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from '../shared/config.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { BffModule } from '../bff/bff.module.js';
import { CampaignController } from './campaign.controller.js';
import { CampaignInternalController, CampaignServiceTokenGuard } from './campaign-internal.controller.js';
import { CampaignPlanController } from './campaign-plan.controller.js';
import { CampaignPlanInternalController } from './campaign-plan-internal.controller.js';
import { CampaignPlanEngineClient } from './campaign-plan-engine.client.js';
import { CampaignPlanJobService } from './campaign-plan-job.service.js';
import { CampaignReplanService } from './campaign-replan.service.js';
import { CampaignService } from './campaign.service.js';
import { CampaignTokenSigner } from './campaign-token.signer.js';
import { OutreachAuthorizationIssuer } from './outreach-authorization.issuer.js';

/**
 * M2.0/M2.1 Campaign 控制面（docs/technical/campaign-control-plane-m2-0.md、
 * docs/superpowers/plans/2026-11-08-campaign-planner-m2-1.md）。
 * TenantGuard/AdminGuard/PrismaService/AuditService 由 TenantModule 导出；
 * M2.1 复用 BffModule 导出的 EngineBudgetGrantService（引擎 quote + Grant 签发）。
 */
@Module({
  imports: [ConfigModule, TenantModule, BffModule],
  controllers: [
    CampaignController,
    CampaignInternalController,
    CampaignPlanController,
    CampaignPlanInternalController,
  ],
  providers: [
    CampaignService,
    CampaignTokenSigner,
    CampaignServiceTokenGuard,
    CampaignPlanEngineClient,
    CampaignPlanJobService,
    CampaignReplanService,
    OutreachAuthorizationIssuer,
  ],
  exports: [CampaignService, OutreachAuthorizationIssuer],
})
export class CampaignModule {}

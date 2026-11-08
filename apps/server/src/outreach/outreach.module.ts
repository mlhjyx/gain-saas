import { Module } from '@nestjs/common';
import { ConfigModule } from '../shared/config.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { EngineOutreachDncChecker } from './outreach-dnc.checker.js';
import { OutreachController } from './outreach.controller.js';
import {
  OUTREACH_DNC_CHECKER,
  OutreachConsentService,
} from './outreach-consent.service.js';
import { OutreachUnsubscribeService } from './outreach-unsubscribe.service.js';

/**
 * M2 步 11-1 合规底座：同意台账、法域矩阵 v0、DNC 预检、退订 token。
 * 11-2/11-3 复用 OutreachConsentService；审批链仍走 M2.0 CampaignModule。
 */
@Module({
  imports: [ConfigModule, TenantModule],
  controllers: [OutreachController],
  providers: [
    OutreachConsentService,
    OutreachUnsubscribeService,
    { provide: OUTREACH_DNC_CHECKER, useClass: EngineOutreachDncChecker },
  ],
  exports: [OutreachConsentService, OutreachUnsubscribeService],
})
export class OutreachModule {}

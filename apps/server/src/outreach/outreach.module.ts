import { Module } from '@nestjs/common';
import { ConfigModule } from '../shared/config.module.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { OutreachBatchController } from './outreach-batch.controller.js';
import { OutreachBatchService } from './outreach-batch.service.js';
import { OutreachPublicController } from './outreach-public.controller.js';
import { OutreachReplyController } from './outreach-reply.controller.js';
import { OutreachReplyService } from './outreach-reply.service.js';
import { OutreachAuthorizationConsumer } from './outreach-authorization.consumer.js';
import {
  OUTREACH_BATCH_LOCK,
  PostgresAdvisoryBatchLock,
} from './outreach-batch-lock.js';
import { OutreachExperimentsController } from './outreach-experiments.controller.js';
import { OutreachExperimentsService } from './outreach-experiments.service.js';
import { OutreachHealthController } from './outreach-health.controller.js';
import { OutreachHealthService } from './outreach-health.service.js';
import { OutreachHealthWorker } from './outreach-health.worker.js';
import { OutreachLegalReviewsService } from './outreach-legal-reviews.service.js';
import { OutreachMetricsController } from './outreach-metrics.controller.js';
import { OutreachMetricsService } from './outreach-metrics.service.js';
import { OutreachMetricsWorker } from './outreach-metrics.worker.js';
import {
  OutreachLegalReviewsController,
  OutreachTemplatesController,
} from './outreach-templates.controller.js';
import { OutreachTemplatesService } from './outreach-templates.service.js';
import { OutreachIngestService } from './outreach-ingest.service.js';
import { OutreachSendJobsService } from './outreach-send-jobs.service.js';
import { OutreachSenderWorker } from './outreach-sender.worker.js';
import {
  ImapFlowClient,
  OUTREACH_IMAP_CLIENT,
  OutreachImapPoller,
} from './outreach-imap.poller.js';
import { OutreachMailboxController } from './outreach-mailbox.controller.js';
import { OutreachMailboxService } from './outreach-mailbox.service.js';
import { OutreachWarmupController } from './outreach-warmup.controller.js';
import { OutreachWarmupService } from './outreach-warmup.service.js';
import { OutreachSeedTestController } from './outreach-seed-test.controller.js';
import { OutreachSeedTestService } from './outreach-seed-test.service.js';
import { OutreachSendController } from './outreach-send.controller.js';
import { OutreachSendControls } from './outreach-send-controls.js';
import { OutreachSendGate } from './outreach-send.gate.js';
import { OutreachSendService } from './outreach-send.service.js';
import {
  OUTREACH_TRANSPORT,
  SmtpOutreachTransport,
} from './outreach-smtp.transport.js';
import {
  EngineOutreachDncChecker,
  OUTREACH_DNC_SUPPRESSOR,
} from './outreach-dnc.checker.js';
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
  controllers: [
    OutreachController,
    OutreachBatchController,
    OutreachSendController,
    OutreachReplyController,
    OutreachPublicController,
    OutreachMailboxController,
    OutreachSeedTestController,
    OutreachWarmupController,
    OutreachHealthController,
    OutreachExperimentsController,
    OutreachMetricsController,
    OutreachLegalReviewsController,
    OutreachTemplatesController,
  ],
  providers: [
    OutreachConsentService,
    OutreachUnsubscribeService,
    OutreachBatchService,
    OutreachSendGate,
    OutreachSendControls,
    OutreachAuthorizationConsumer,
    OutreachMailboxService,
    OutreachSeedTestService,
    OutreachWarmupService,
    OutreachIngestService,
    ImapFlowClient,
    { provide: OUTREACH_IMAP_CLIENT, useExisting: ImapFlowClient },
    OutreachImapPoller,
    OutreachSendJobsService,
    PostgresAdvisoryBatchLock,
    { provide: OUTREACH_BATCH_LOCK, useExisting: PostgresAdvisoryBatchLock },
    OutreachSenderWorker,
    OutreachHealthService,
    OutreachHealthWorker,
    OutreachExperimentsService,
    OutreachMetricsService,
    OutreachMetricsWorker,
    OutreachLegalReviewsService,
    OutreachTemplatesService,
    OutreachSendService,
    OutreachReplyService,
    EngineOutreachDncChecker,
    { provide: OUTREACH_DNC_CHECKER, useExisting: EngineOutreachDncChecker },
    { provide: OUTREACH_DNC_SUPPRESSOR, useExisting: EngineOutreachDncChecker },
    { provide: OUTREACH_TRANSPORT, useClass: SmtpOutreachTransport },
  ],
  exports: [
    OutreachConsentService,
    OutreachUnsubscribeService,
    OutreachBatchService,
    OutreachSendGate,
    OutreachSendService,
    OutreachReplyService,
  ],
})
export class OutreachModule {}

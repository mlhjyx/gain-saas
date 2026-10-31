import { Inject, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { AuditService } from '../shared/audit.service.js';
import { R4Keyring } from './r4-keyring.service.js';
import { R4JwksController } from './r4-jwks.controller.js';
import { LegacyJwksController } from './legacy-jwks.controller.js';
import { PlatformGrantIssuer } from './platform-grant.service.js';
import { PlatformGrantController } from './platform-grant.controller.js';
import { MachineTokenService } from './machine-token.service.js';
import { MachineTokenController } from './machine-token.controller.js';
import { CapabilityIssuer } from './capability-issuer.service.js';
import { RevocationIssuer } from './revocation-issuer.service.js';
import { RevocationClient } from './revocation-client.service.js';
import { FenceAckVerifier } from './fence-ack-verifier.service.js';
import { CapabilityController } from './capability.controller.js';
import {
  PlatformFactsService,
  REVOCATION_BACKLOG_PROBE,
  TEMPORAL_SCHEDULE_PROBE,
} from './platform-facts.service.js';
import { UnavailableTemporalScheduleProbe } from './unavailable-probes.js';
import { R4LeaseService } from './r4-lease.service.js';
import { EgressPolicyService, FENCE_STORE, QUOTE_SOURCE } from './egress-policy.service.js';
import { FileQuoteSource, PgFenceStore } from './egress-adapters.js';
import { OpsDatabase } from '../ops/ops-database.service.js';
import {
  SCHEDULE_LISTER,
  TemporalClientScheduleLister,
  TemporalScheduleProbeService,
} from './temporal-schedule-probe.service.js';
import { LeaseHeartbeatService } from './lease-heartbeat.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import { PlatformRevocationService } from './platform-revocation.service.js';
import { PlatformPolicyStateService, PLATFORM_POLICY_GUARD } from './platform-policy-state.service.js';
import { PlatformRevocationDeliveryService } from './platform-revocation-delivery.service.js';
import { BindingRevocationWatcher } from './binding-revocation-watcher.service.js';

/**
 * R4 平台权威（P1 起）。与租户/运营/服务三域并列，不共享密钥与守卫链。
 */
@Module({
  imports: [ConfigModule],
  controllers: [R4JwksController, LegacyJwksController, MachineTokenController, CapabilityController, PlatformGrantController],
  providers: [
    R4Keyring,
    MachineTokenService,
    PlatformGrantIssuer,
    CapabilityIssuer,
    RevocationIssuer,
    RevocationClient,
    FenceAckVerifier,
    PlatformFactsService,
    { provide: SCHEDULE_LISTER, useClass: TemporalClientScheduleLister },
    { provide: TEMPORAL_SCHEDULE_PROBE, useClass: TemporalScheduleProbeService },
    LeaseHeartbeatService,
    PrismaService,
    R4LeaseService,
    OpsDatabase,
    EgressPolicyService,
    { provide: FENCE_STORE, useClass: PgFenceStore },
    { provide: QUOTE_SOURCE, useClass: FileQuoteSource },
    { provide: REVOCATION_BACKLOG_PROBE, useExisting: R4LeaseService },
    AuditService,
    PlatformRevocationService,
    PlatformPolicyStateService,
    { provide: PLATFORM_POLICY_GUARD, useExisting: PlatformPolicyStateService },
    PlatformRevocationDeliveryService,
    BindingRevocationWatcher,
  ],
  exports: [
    R4Keyring, MachineTokenService, CapabilityIssuer, RevocationIssuer, RevocationClient,
    FenceAckVerifier, R4LeaseService, EgressPolicyService, PlatformRevocationService,
    PlatformPolicyStateService,
  ],
})
export class R4Module implements OnModuleInit {
  private readonly logger = new Logger('R4Module');

  constructor(
    private readonly keyring: R4Keyring,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly policy: PlatformPolicyStateService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.keyring.init();
    if (!this.config.R4_REVOCATION_TRIGGER_ENABLED) return;
    if (this.config.PROCESS_ROLE !== 'web') return;
    await this.policy.sync().catch((error) => {
      this.logger.warn(`策略状态基线同步失败（投递循环会重试）: ${(error as Error).message}`);
    });
  }
}

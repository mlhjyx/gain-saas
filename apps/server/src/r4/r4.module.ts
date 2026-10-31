import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '../shared/config.module.js';
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
  ],
  exports: [R4Keyring, MachineTokenService, CapabilityIssuer, RevocationIssuer, RevocationClient, FenceAckVerifier, R4LeaseService, EgressPolicyService],
})
export class R4Module implements OnModuleInit {
  constructor(private readonly keyring: R4Keyring) {}

  async onModuleInit(): Promise<void> {
    await this.keyring.init();
  }
}

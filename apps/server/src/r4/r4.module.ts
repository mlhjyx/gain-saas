import { Module, OnModuleInit } from '@nestjs/common';
import { R4Keyring } from './r4-keyring.service.js';
import { R4JwksController } from './r4-jwks.controller.js';
import { MachineTokenService } from './machine-token.service.js';
import { MachineTokenController } from './machine-token.controller.js';
import { CapabilityIssuer } from './capability-issuer.service.js';
import { CapabilityController } from './capability.controller.js';
import {
  PlatformFactsService,
  REVOCATION_BACKLOG_PROBE,
  TEMPORAL_SCHEDULE_PROBE,
} from './platform-facts.service.js';
import {
  UnavailableRevocationBacklogProbe,
  UnavailableTemporalScheduleProbe,
} from './unavailable-probes.js';

/**
 * R4 平台权威（P1 起）。与租户/运营/服务三域并列，不共享密钥与守卫链。
 */
@Module({
  controllers: [R4JwksController, MachineTokenController, CapabilityController],
  providers: [
    R4Keyring,
    MachineTokenService,
    CapabilityIssuer,
    PlatformFactsService,
    { provide: TEMPORAL_SCHEDULE_PROBE, useClass: UnavailableTemporalScheduleProbe },
    { provide: REVOCATION_BACKLOG_PROBE, useClass: UnavailableRevocationBacklogProbe },
  ],
  exports: [R4Keyring, MachineTokenService, CapabilityIssuer],
})
export class R4Module implements OnModuleInit {
  constructor(private readonly keyring: R4Keyring) {}

  async onModuleInit(): Promise<void> {
    await this.keyring.init();
  }
}

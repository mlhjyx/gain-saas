import { Module, OnModuleInit } from '@nestjs/common';
import { R4Keyring } from './r4-keyring.service.js';
import { R4JwksController } from './r4-jwks.controller.js';

/**
 * R4 平台权威（P1 起）。与租户/运营/服务三域并列，不共享密钥与守卫链。
 */
@Module({
  controllers: [R4JwksController],
  providers: [R4Keyring],
  exports: [R4Keyring],
})
export class R4Module implements OnModuleInit {
  constructor(private readonly keyring: R4Keyring) {}

  async onModuleInit(): Promise<void> {
    await this.keyring.init();
  }
}

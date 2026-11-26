import { Module } from '@nestjs/common';
import { ConfigModule } from './config.module.js';
import { PiiCryptoService } from './pii-crypto.service.js';

/**
 * 独立 PII 加密模块：单向依赖 ConfigModule，避免与 APP_CONFIG 令牌形成 ESM 循环引用。
 */
@Module({
  imports: [ConfigModule],
  providers: [PiiCryptoService],
  exports: [PiiCryptoService],
})
export class PiiCryptoModule {}

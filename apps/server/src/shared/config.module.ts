import { Module, type Provider } from '@nestjs/common';
import { loadConfig, type AppConfig } from '../config/configuration.js';
import { PiiCryptoService } from './pii-crypto.service.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

export const appConfigProvider: Provider = {
  provide: APP_CONFIG,
  useFactory: () => loadConfig(),
};

@Module({
  providers: [appConfigProvider, PiiCryptoService],
  exports: [appConfigProvider, PiiCryptoService],
})
export class ConfigModule {}

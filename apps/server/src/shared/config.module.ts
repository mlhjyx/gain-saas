import { Module, type Provider } from '@nestjs/common';
import { loadConfig, type AppConfig } from '../config/configuration.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

export const appConfigProvider: Provider = {
  provide: APP_CONFIG,
  useFactory: () => loadConfig(),
};

@Module({
  providers: [appConfigProvider],
  exports: [appConfigProvider],
})
export class ConfigModule {}

import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { R4JwksController } from './r4-jwks.controller.js';
import { R4Keyring } from './r4-keyring.service.js';

async function controller(env: Partial<AppConfig>): Promise<R4JwksController> {
  const keyring = new R4Keyring({ NODE_ENV: 'development', ...env } as unknown as AppConfig);
  await keyring.init();
  return new R4JwksController(keyring);
}

describe('R4 JWKS 端点', () => {
  it('开发环境返回三份公钥 JWKS', async () => {
    const c = await controller({});
    for (const jwks of [
      c.capability(),
      c.temporalRuntime(),
      c.siteBuildBudget(),
    ]) {
      expect(jwks.keys).toHaveLength(1);
      expect(jwks.keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
      expect(jwks.keys[0]).not.toHaveProperty('d');
    }
  });

  it('生产未配置时返回 503 与稳定 code，而不是空 JWKS', async () => {
    const c = await controller({ NODE_ENV: 'production' });
    for (const call of [() => c.capability(), () => c.temporalRuntime(), () => c.siteBuildBudget()]) {
      try {
        call();
        throw new Error('应当抛 503');
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceUnavailableException);
        const response = (error as ServiceUnavailableException).getResponse() as {
          error: { code: string };
        };
        expect(response.error.code).toBe('R4_JWKS_UNAVAILABLE');
      }
    }
  });
});

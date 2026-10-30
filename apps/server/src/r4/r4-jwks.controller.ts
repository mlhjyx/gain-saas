import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { R4Keyring, type R4KeyFamily } from './r4-keyring.service.js';

/**
 * R4 平台权威的 JWKS（P1）。
 *
 * 只出公钥。族未配置（生产）时返回 503 并带稳定 code，而不是空 JWKS——
 * 引擎的验签器遇到空 keys 会静默判成「验不过」，运维看不出是配置缺失还是签名错误。
 *
 * `machine` 族暂不单独出端点：后端 `CAPABILITY_MACHINE_JWKS_URI` 指向
 * `/.well-known/jwks.json`，与 SaaS 自有身份钥同一个路径，合并发布要等 P2/P7 的切换决定。
 */
@Controller('.well-known')
export class R4JwksController {
  constructor(private readonly keyring: R4Keyring) {}

  /** 机器 token 验签钥（引擎 CAPABILITY_MACHINE_JWKS_URI 可指向这里，避免与身份钥同文件）。 */
  @Get('machine-jwks.json')
  machine(): { keys: JsonWebKey[] } {
    return this.serve('machine');
  }

  @Get('platform-capability-jwks.json')
  capability(): { keys: JsonWebKey[] } {
    return this.serve('capability');
  }

  @Get('temporal-runtime-jwks.json')
  temporalRuntime(): { keys: JsonWebKey[] } {
    return this.serve('temporalRuntime');
  }

  @Get('site-build-budget-jwks.json')
  siteBuildBudget(): { keys: JsonWebKey[] } {
    return this.serve('siteBuildBudget');
  }

  private serve(family: R4KeyFamily): { keys: JsonWebKey[] } {
    if (!this.keyring.isAvailable(family)) {
      throw new ServiceUnavailableException({
        error: { code: 'R4_JWKS_UNAVAILABLE', message: `R4 密钥族未配置: ${family}` },
      });
    }
    return this.keyring.publicJwks(family);
  }
}

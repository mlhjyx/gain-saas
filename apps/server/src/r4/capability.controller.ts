import { BadRequestException, Body, Controller, Post, ServiceUnavailableException } from '@nestjs/common';
import { CapabilityIssuer } from './capability-issuer.service.js';
import { PlatformFactsService, PlatformFactsUnavailable } from './platform-facts.service.js';

/**
 * 引擎的 capability 端点（P3b）。
 *
 * 请求体恰好 `{ nonce }`；响应是签名后的 JOSE 字符串。
 * 事实不可用（绑定过期、Temporal 读不到、消费者事实缺失）一律 503
 * `PLATFORM_CAPABILITY_UNAVAILABLE`，与引擎现在的失败码一致——
 * 宁可让平台自动化停下来，也不发出一份基于陈旧事实的能力。
 */
@Controller('api/internal/v1/platform-automation')
export class CapabilityController {
  constructor(
    private readonly facts: PlatformFactsService,
    private readonly issuer: CapabilityIssuer,
  ) {}

  @Post('capabilities')
  async issue(@Body() body: { nonce?: unknown }): Promise<string> {
    if (typeof body?.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(body.nonce)) {
      throw new BadRequestException({
        error: { code: 'CAPABILITY_REQUEST_INVALID', message: '需要 { nonce }（32 位小写 hex）' },
      });
    }
    const now = Date.now();
    try {
      const { observations, binding } = await this.facts.collect(now);
      return await this.issuer.issue(
        observations,
        {
          nonce: body.nonce,
          backendSha: binding.backendSha,
          growthosSha: binding.growthosSha ?? binding.backendSha,
          policyDigest: binding.policyDigest ?? `sha256:${'0'.repeat(64)}`,
        },
        now,
      );
    } catch (error) {
      if (error instanceof PlatformFactsUnavailable) {
        throw new ServiceUnavailableException({
          error: { code: 'PLATFORM_CAPABILITY_UNAVAILABLE', message: error.reason },
        });
      }
      throw error;
    }
  }
}

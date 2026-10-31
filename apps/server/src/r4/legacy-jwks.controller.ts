import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';

/**
 * P8 退役 GrowthOS 用的**冻结公钥**端点。
 *
 * 引擎里还有三处信任根直接指向 GrowthOS 的公开 JWKS：
 *  - `PLATFORM_TECHNICAL_QUOTE_AUTH_JWKS_URI`（技术报价服务身份）
 *  - `PLATFORM_AUTHORITY_TARGET_READER_JWKS_URI`（恢复通道 reader 身份）
 *  - `SITE_BUILD_BUDGET_GRANT_JWKS_URI`（站点构建预算 Grant）
 *
 * GrowthOS 停止后这些 URL 会不可达，readiness 的对应组件随之掉线并关闭客户侧写入。
 * 退役方案是把当前公钥**原样冻结**到 gain-saas 托管（公钥本身不敏感，issuer 字符串
 * 与私钥都不迁移；P8 前没有任何新签发发生）。以后要恢复这些通道，由 gain-saas
 * 用自有钥族重新签发并同步切换引擎的 issuer/JWKS 配置。
 */
@Controller('.well-known')
export class LegacyJwksController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get('legacy-identity-jwks.json')
  identity(): unknown {
    return this.serve('growthos-identity-jwks.json');
  }

  @Get('legacy-site-build-budget-jwks.json')
  siteBuildBudget(): unknown {
    return this.serve('growthos-site-build-budget-jwks.json');
  }

  private serve(name: string): unknown {
    const dir = this.config.R4_LEGACY_JWKS_DIR;
    if (!dir) throw new ServiceUnavailableException({ error: { code: 'R4_JWKS_UNAVAILABLE', message: 'legacy JWKS 未配置' } });
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { keys?: unknown }).keys) || (parsed as { keys: unknown[] }).keys.length === 0)
        throw new Error('empty');
      return parsed;
    } catch {
      throw new ServiceUnavailableException({ error: { code: 'R4_JWKS_UNAVAILABLE', message: `legacy JWKS 不可用: ${name}` } });
    }
  }
}

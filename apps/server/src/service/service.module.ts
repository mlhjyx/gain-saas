import { Controller, forwardRef, Get, Inject, Module, Optional, ServiceUnavailableException } from '@nestjs/common';
import { APP_CONFIG, ConfigModule } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import { EngineTokenSigner } from './engine-token.signer.js';
import { EngineBudgetGrantSigner } from './engine-budget-grant.signer.js';
import { EventConsumerService } from './event-consumer.service.js';
import { WalletModule } from '../wallet/wallet.module.js';

/**
 * 服务域(SD4/SD5):JWKS 签发 + 事件消费。
 * EngineTokenSigner:BFF 现铸引擎身份 JWT(≤60s TTL),JWKS 端点暴露公钥;
 * EngineBudgetGrantSigner:写路由的执行预算 Grant 签发(独立钥/issuer);
 * EventConsumer:按 workspace_registry 逐 workspace 拉取→幂等入库→派生→ACK。
 */

@Controller('.well-known')
export class JwksController {
  constructor(
    private readonly signer: EngineTokenSigner,
    private readonly budgetSigner: EngineBudgetGrantSigner,
    @Optional() @Inject(APP_CONFIG) private readonly config?: AppConfig,
  ) {}

  @Get('jwks.json')
  async jwks() {
    return this.signer.publicJwks();
  }

  /**
   * 引擎 EXECUTION_BUDGET_GRANT_JWKS_URI 指向这里(只含预算公钥)。
   * 在 LEGACY_EXECUTION_BUDGET_MODE=bypass 且未配置旧签名钥时返回清晰 503，不抛未捕获 500。
   */
  @Get('execution-budget-jwks.json')
  executionBudgetJwks() {
    if (this.config?.LEGACY_EXECUTION_BUDGET_MODE === 'bypass' && !this.budgetSigner.hasPublicJwks) {
      throw new ServiceUnavailableException({
        error: {
          code: 'LEGACY_EXECUTION_BUDGET_BYPASSED',
          mode: 'bypass',
          message: '旧执行预算已处于旁路模式（LEGACY_EXECUTION_BUDGET_MODE=bypass），未发布 Grant 公钥',
        },
      });
    }
    return this.budgetSigner.publicJwks;
  }
}

export function rolesForMembership(role: string): 'saas-admin' | 'saas-member' {
  return role === 'admin' ? 'saas-admin' : 'saas-member';
}

@Module({
  imports: [ConfigModule, forwardRef(() => WalletModule)],
  controllers: [JwksController],
  providers: [EngineTokenSigner, EngineBudgetGrantSigner, EventConsumerService, PrismaService],
  exports: [EngineTokenSigner, EngineBudgetGrantSigner, EventConsumerService, PrismaService],
})
export class ServiceModule {}

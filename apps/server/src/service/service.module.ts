import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '../shared/config.module.js';
import { PrismaService } from '../shared/prisma.service.js';
import { EngineTokenSigner } from './engine-token.signer.js';
import { EngineBudgetGrantSigner } from './engine-budget-grant.signer.js';
import { EventConsumerService } from './event-consumer.service.js';

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
  ) {}

  @Get('jwks.json')
  async jwks() {
    return this.signer.publicJwks();
  }

  /** 引擎 EXECUTION_BUDGET_GRANT_JWKS_URI 指向这里(只含预算公钥)。 */
  @Get('execution-budget-jwks.json')
  executionBudgetJwks() {
    return this.budgetSigner.publicJwks;
  }
}

export function rolesForMembership(role: string): 'saas-admin' | 'saas-member' {
  return role === 'admin' ? 'saas-admin' : 'saas-member';
}

@Module({
  imports: [ConfigModule],
  controllers: [JwksController],
  providers: [EngineTokenSigner, EngineBudgetGrantSigner, EventConsumerService, PrismaService],
  exports: [EngineTokenSigner, EngineBudgetGrantSigner, EventConsumerService],
})
export class ServiceModule {}

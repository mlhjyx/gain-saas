import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_APP_MODULE = join(SERVER_ROOT, 'dist', 'app.module.js');

function ensureServerBuilt(): void {
  if (!existsSync(DIST_APP_MODULE)) {
    execFileSync(join(SERVER_ROOT, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
      cwd: SERVER_ROOT,
      stdio: 'pipe',
    });
  }
}

function generateTestRsaPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

let cachedKeys: { jwtPem: string; budgetPem: string } | null = null;
function getTestRsaKeys(): { jwtPem: string; budgetPem: string } {
  if (!cachedKeys) {
    cachedKeys = {
      jwtPem: generateTestRsaPem(),
      budgetPem: generateTestRsaPem(),
    };
  }
  return cachedKeys;
}

/**
 * 真实 NestJS AppModule 启动 DI 装配冒烟测试（覆盖 web 与 worker 两种 PROCESS_ROLE）：
 * - 在独立纯净 Node.js ESM 子进程中直接加载 tsc 编译产物 `dist/app.module.js` 并运行
 *   `NestFactory.createApplicationContext(AppModule)`，不 mock 任何模块声明，100% 复现生产模块图与
 *   `emitDecoratorMetadata` 运行态；
 * - 仅将 `PrismaService` 的生命周期钩子置为 no-op（不连接真实数据库），验证全部业务模块、控制器、
 *   守卫与循环依赖（TenantModule <-> ServiceModule <-> WalletModule）完整装配且无
 *   `UndefinedModuleException` / `UnknownDependenciesException`。
 */
function runRealAppModuleBootstrap(processRole: 'web' | 'worker'): {
  ok: boolean;
  resolved: string[];
  eventConsumerHasWallet: boolean;
  bffHandlerHasWallet: boolean;
} {
  ensureServerBuilt();
  const { jwtPem, budgetPem } = getTestRsaKeys();

  const probeScript = `
    import 'reflect-metadata';
    import { NestFactory } from '@nestjs/core';
    import { PrismaService } from './dist/shared/prisma.service.js';
    import { AppModule } from './dist/app.module.js';
    import { BffGuard, BffHandler } from './dist/bff/bff.module.js';
    import { AcquisitionTasksController } from './dist/bff/acquisition-tasks.controller.js';
    import { DeletionMirrorsController } from './dist/tenant/deletion-mirrors.controller.js';
    import { EventConsumerService } from './dist/service/event-consumer.service.js';
    import { EngineTokenSigner } from './dist/service/engine-token.signer.js';
    import { EngineBudgetGrantSigner } from './dist/service/engine-budget-grant.signer.js';
    import { SessionService } from './dist/tenant/session.service.js';
    import { WalletService } from './dist/wallet/wallet.service.js';
    import { WalletController } from './dist/wallet/wallet.controller.js';
    import { OpsWalletController } from './dist/wallet/ops-wallet.controller.js';
    import { CampaignService } from './dist/campaign/campaign.service.js';
    import { OutreachSendService } from './dist/outreach/outreach-send.service.js';
    import { OutreachMailboxService } from './dist/outreach/outreach-mailbox.service.js';
    import { OutreachOAuthService } from './dist/outreach/outreach-oauth.service.js';
    import { OutreachOAuthController } from './dist/outreach/outreach-oauth.controller.js';
    import { OutreachDomainController } from './dist/outreach/outreach-domain.controller.js';
    import { PiiCryptoService } from './dist/shared/pii-crypto.service.js';

    PrismaService.prototype.onModuleInit = async () => {};
    PrismaService.prototype.onModuleDestroy = async () => {};

    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
    try {
      const checks = [
        ['BffHandler', BffHandler],
        ['BffGuard', BffGuard],
        ['AcquisitionTasksController', AcquisitionTasksController],
        ['DeletionMirrorsController', DeletionMirrorsController],
        ['EventConsumerService', EventConsumerService],
        ['EngineTokenSigner', EngineTokenSigner],
        ['EngineBudgetGrantSigner', EngineBudgetGrantSigner],
        ['SessionService', SessionService],
        ['WalletService', WalletService],
        ['WalletController', WalletController],
        ['OpsWalletController', OpsWalletController],
        ['CampaignService', CampaignService],
        ['OutreachSendService', OutreachSendService],
        ['OutreachMailboxService', OutreachMailboxService],
        ['OutreachOAuthService', OutreachOAuthService],
        ['OutreachOAuthController', OutreachOAuthController],
        ['OutreachDomainController', OutreachDomainController],
        ['PiiCryptoService', PiiCryptoService],
      ];
      const resolved = [];
      for (const [name, token] of checks) {
        const instance = app.get(token);
        if (!instance) throw new Error('Failed to resolve ' + name);
        resolved.push(name);
      }
      const consumer = app.get(EventConsumerService);
      const bff = app.get(BffHandler);
      const result = {
        ok: true,
        resolved,
        eventConsumerHasWallet: Boolean(consumer.wallet),
        bffHandlerHasWallet: Boolean(bff.wallet),
      };
      console.log('__DI_SMOKE_RESULT__' + JSON.stringify(result));
    } finally {
      await app.close();
    }
    process.exit(0);
  `;

  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', probeScript], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PROCESS_ROLE: processRole,
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
      APP_DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
      SESSION_SECRET: 's'.repeat(64),
      ENGINE_JWT_PRIVATE_KEY: jwtPem,
      ENGINE_JWT_KEY_ID: 'di-smoke-jwt-k1',
      ENGINE_JWT_ISSUER: 'https://di-smoke.local',
      ENGINE_BUDGET_GRANT_PRIVATE_KEY: budgetPem,
      ENGINE_BUDGET_GRANT_KEY_ID: 'di-smoke-budget-k1',
      ENGINE_BUDGET_GRANT_ISSUER: 'https://di-smoke-budget.local',
      EVENT_CONSUMER_ENABLED: 'false',
      WALLET_HOLD_SWEEP_ENABLED: 'false',
      OUTREACH_IMAP_ENABLED: 'false',
      OUTREACH_SENDER_WORKER_ENABLED: 'false',
      OUTREACH_HEALTH_WORKER_ENABLED: 'false',
      OUTREACH_METRICS_WORKER_ENABLED: 'false',
      OUTREACH_RECONCILIATION_WORKER_ENABLED: 'false',
      OUTREACH_BOUNCE_WRITEBACK_WORKER_ENABLED: 'false',
      R4_REVOCATION_TRIGGER_ENABLED: 'false',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });

  const marker = '__DI_SMOKE_RESULT__';
  const line = stdout
    .split('\n')
    .find((entry) => entry.startsWith(marker));
  if (!line) {
    throw new Error(`DI smoke probe did not emit result marker. stdout:\n${stdout}`);
  }
  return JSON.parse(line.slice(marker.length));
}

describe('AppModule 真实 NestJS DI 启动装配冒烟（web + worker）', () => {
  it('web 进程角色完整装配 AppModule 无循环依赖且 WalletService 注入 EventConsumerService/BffHandler', () => {
    const res = runRealAppModuleBootstrap('web');
    expect(res.ok).toBe(true);
    expect(res.resolved).toContain('WalletService');
    expect(res.resolved).toContain('WalletController');
    expect(res.resolved).toContain('OpsWalletController');
    expect(res.resolved).toContain('EventConsumerService');
    expect(res.resolved).toContain('BffHandler');
    expect(res.resolved).toContain('AcquisitionTasksController');
    expect(res.resolved).toContain('DeletionMirrorsController');
    expect(res.eventConsumerHasWallet).toBe(true);
    expect(res.bffHandlerHasWallet).toBe(true);
  }, 60_000);

  it('worker 进程角色完整装配 AppModule 无循环依赖', () => {
    const res = runRealAppModuleBootstrap('worker');
    expect(res.ok).toBe(true);
    expect(res.resolved).toContain('EventConsumerService');
    expect(res.eventConsumerHasWallet).toBe(true);
  }, 60_000);
});

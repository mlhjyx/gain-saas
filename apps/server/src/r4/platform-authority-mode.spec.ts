import { ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { HealthController } from '../health/health.controller.js';
import { OpsRevocationController } from '../ops/ops-revocation.controller.js';
import type { OpsDatabase } from '../ops/ops-database.service.js';
import { OpsService } from '../ops/ops.service.js';
import { BindingRevocationWatcher } from './binding-revocation-watcher.service.js';
import { CapabilityController } from './capability.controller.js';
import { LeaseHeartbeatService } from './lease-heartbeat.service.js';
import { LegacyJwksController } from './legacy-jwks.controller.js';
import { MachineTokenController } from './machine-token.controller.js';
import { PlatformCrawlGrantController } from './platform-crawl-grant.controller.js';
import { PlatformFactsService, PlatformFactsUnavailable } from './platform-facts.service.js';
import { PlatformGrantController } from './platform-grant.controller.js';
import { PlatformRevocationDeliveryService } from './platform-revocation-delivery.service.js';
import { R4JwksController } from './r4-jwks.controller.js';
import { R4Keyring } from './r4-keyring.service.js';
import { R4Module } from './r4.module.js';
import { loadMtlsOptions, loadTlsOptions, startR4TlsServers } from './r4-tls.server.js';
import { TemporalScheduleProbeService } from './temporal-schedule-probe.service.js';

const TLS_REQ = { socket: { encrypted: true } } as unknown as Request;
const MTLS_WORKER_REQ = {
  socket: {
    encrypted: true,
    authorized: true,
    getPeerCertificate: () => ({ subject: { CN: 'global-backend-platform-worker' } }),
  },
} as unknown as Request;

function internalDbConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    NODE_ENV: 'production',
    PROCESS_ROLE: 'web',
    PLATFORM_AUTHORITY_MODE: 'internal_db',
    LEGACY_EXECUTION_BUDGET_MODE: 'bypass',
    EVENT_CONSUMER_ENABLED: false,
    ENGINE_ORIGIN: 'http://127.0.0.1:3000',
    R4_LEASE_HEARTBEAT_ENABLED: true,
    R4_REVOCATION_TRIGGER_ENABLED: true,
    R4_REVOCATION_AUTO_CONFIRM: true,
    R4_TEMPORAL_ENABLED: true,
    R4_DEPLOYMENT_BINDING_FILE: '/nonexistent/deployment-binding.json',
    R4_TEMPORAL_OPERATOR_PUBLIC_KEY_FILE: '/nonexistent/operator.pub',
    R4_TLS_PORT: 18446,
    R4_MTLS_PORT: 18448,
    R4_TLS_HOST: '127.0.0.1',
    R4_TLS_CLIENT_AUTH: 'none',
    R4_PLATFORM_GRANT_CLIENT_SUBJECT: 'global-backend-platform-worker',
    ...overrides,
  } as unknown as AppConfig;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PLATFORM_AUTHORITY_MODE=internal_db 轻量化模式', () => {
  it('R4Module 与 R4Keyring 在 internal_db 下跳过全部密钥加载、不生成临时 RSA 钥、不读取 binding/operator 文件', async () => {
    const config = internalDbConfig({ NODE_ENV: 'development' });
    const keyring = new R4Keyring(config);
    const policy = { sync: vi.fn(async () => undefined) };
    const module = new R4Module(keyring, config, policy as never);

    await module.onModuleInit();
    expect(policy.sync).not.toHaveBeenCalled();

    // 即使直接调用 keyring.init() 也必须跳过（不读取不存在的 operator 文件，也不生成临时密钥）
    await expect(keyring.init()).resolves.toBeUndefined();
    for (const family of ['machine', 'capability', 'temporalRuntime', 'siteBuildBudget'] as const) {
      expect(keyring.isAvailable(family)).toBe(false);
    }
  });

  it('R4 TLS/mTLS 监听在 internal_db 模式下完全跳过（即使配了 18446/18448 且证书缺失也不报错）', async () => {
    const config = internalDbConfig();
    const readFile = vi.fn(() => {
      throw new Error('should not read cert files');
    });
    expect(loadTlsOptions(config, readFile)).toBeNull();
    expect(loadMtlsOptions(config, readFile)).toBeNull();
    await expect(startR4TlsServers({} as never, config, readFile)).resolves.toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('三个 R4 后台定时器在 internal_db 下静默停机（零 setInterval 泄漏、零 DB/文件调用）', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const config = internalDbConfig();

    const renew = vi.fn();
    const leaseHeartbeat = new LeaseHeartbeatService(config, { renew } as never);
    leaseHeartbeat.onModuleInit();

    const findMany = vi.fn();
    const revCreate = vi.fn();
    const bindingWatcher = new BindingRevocationWatcher(
      config,
      { r4PlatformPolicyState: { findMany } } as never,
      { create: revCreate } as never,
    );
    bindingWatcher.onModuleInit();
    await bindingWatcher.check();

    const policySync = vi.fn();
    const reqFindMany = vi.fn();
    const delivery = new PlatformRevocationDeliveryService(
      config,
      { r4RevocationRequest: { findMany: reqFindMany } } as never,
      {} as never,
      { sync: policySync } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    delivery.onModuleInit();
    await delivery.tick();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(revCreate).not.toHaveBeenCalled();
    expect(policySync).not.toHaveBeenCalled();
    expect(reqFindMany).not.toHaveBeenCalled();

    leaseHeartbeat.onModuleDestroy();
    bindingWatcher.onModuleDestroy();
    delivery.onModuleDestroy();
  });

  it('PlatformFactsService 与 TemporalScheduleProbeService 在 internal_db 下不读绑定文件且不连 Temporal', async () => {
    const config = internalDbConfig();
    const lister = { list: vi.fn(async () => []) };
    const probe = new TemporalScheduleProbeService(config, lister);
    await expect(probe.read(Date.now())).resolves.toBeNull();
    expect(lister.list).not.toHaveBeenCalled();

    const facts = new PlatformFactsService(config, probe, { read: vi.fn(async () => null) });
    expect(() => facts.readBinding(Date.now())).toThrow(PlatformFactsUnavailable);
  });

  it('R4 HTTP 端点在 internal_db 下返回 503 PLATFORM_AUTHORITY_INTERNAL_DB_MODE 并带 mode=internal_db', async () => {
    const config = internalDbConfig();
    const keyring = new R4Keyring(config);
    await keyring.init();

    const assertInternalDb503 = async (fn: () => unknown) => {
      try {
        await fn();
        throw new Error('expected 503');
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceUnavailableException);
        expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
          error: { code: 'PLATFORM_AUTHORITY_INTERNAL_DB_MODE', mode: 'internal_db' },
        });
      }
    };

    const r4Jwks = new R4JwksController(keyring, config);
    await assertInternalDb503(() => r4Jwks.capability());
    await assertInternalDb503(() => r4Jwks.machine());

    const legacyJwks = new LegacyJwksController(config);
    await assertInternalDb503(() => legacyJwks.identity());

    const capability = new CapabilityController({} as never, {} as never, config);
    await assertInternalDb503(() => capability.issue({ nonce: 'a'.repeat(32) }, TLS_REQ));

    const machineToken = new MachineTokenController(config, keyring, {} as never);
    await assertInternalDb503(() => machineToken.issue({ profile: 'capability', nonce: 'n1' }, TLS_REQ));

    const platformGrant = new PlatformGrantController(config, {} as never);
    await assertInternalDb503(() => platformGrant.issue({}, MTLS_WORKER_REQ));

    const crawlGrant = new PlatformCrawlGrantController(config, {} as never);
    await assertInternalDb503(() => crawlGrant.issue({}, MTLS_WORKER_REQ));
  });

  it('OpsRevocationController / OpsService.overview / HealthController.ready 在 internal_db 下返回清晰 mode=internal_db 不崩溃', async () => {
    const config = internalDbConfig();

    const revocations = {
      list: vi.fn(),
      policyStates: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      confirm: vi.fn(),
      cancel: vi.fn(),
    };
    const opsR4 = new OpsRevocationController(config, revocations as never);
    await expect(opsR4.list()).resolves.toMatchObject({ mode: 'internal_db', requests: [] });
    await expect(opsR4.policyState()).resolves.toMatchObject({
      mode: 'internal_db',
      states: [],
      triggerEnabled: false,
      autoConfirm: false,
    });
    expect(revocations.list).not.toHaveBeenCalled();
    expect(revocations.policyStates).not.toHaveBeenCalled();

    await expect(opsR4.create({}, { opsUser: { email: 'ops@test' } } as never)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(opsR4.cancel('id-1', { reason: 'test' }, { opsUser: { email: 'ops@test' } } as never)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    // OpsService.overview() 在 internal_db 下不查 r4RevocationRequest，返回 mode='internal_db'
    const r4Count = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'ok', components: {} }), { status: 200 })),
    );
    const opsDb = {
      db: {
        ownerPool: null,
        health: vi.fn(async () => ({ ok: true })),
        query: vi.fn(async () => []),
      },
      ready: vi.fn(async () => ({ ok: true })),
    } as unknown as OpsDatabase;
    const opsService = new OpsService(
      config,
      opsDb,
      { health: vi.fn(async () => true) } as never,
      {} as never,
      { r4RevocationRequest: { count: r4Count } } as never,
      {} as never,
    );
    const overview = await opsService.overview();
    expect(r4Count).not.toHaveBeenCalled();
    expect(overview.modes).toEqual({
      legacyExecutionBudget: 'bypass',
      platformAuthority: 'internal_db',
    });
    expect(overview.redLights.r4).toEqual({
      mode: 'internal_db',
      openRevocations: 0,
      deliveryUnknown: 0,
      platformExhaustedAuthorities: 0,
    });

    // HealthController.ready() 返回清晰 mode='internal_db'
    const health = new HealthController(config, { health: vi.fn(async () => ({ ok: true, latencyMs: 1 })) } as never);
    const ready = await health.ready();
    expect(ready.status).toBe('ok');
    expect(ready.platformAuthority).toEqual({ mode: 'internal_db' });
    expect(ready.capabilities).toEqual({
      event_consumer: false,
      legacy_execution_budget_mode: 'bypass',
      platform_authority_mode: 'internal_db',
    });
  });
});

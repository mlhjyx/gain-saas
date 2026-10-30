import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { CapabilityController } from './capability.controller.js';
import { CapabilityIssuer } from './capability-issuer.service.js';
import {
  PlatformFactsService,
  type RevocationBacklogProbe,
  type RevocationConsumerFact,
  type TemporalScheduleFact,
  type TemporalScheduleProbe,
} from './platform-facts.service.js';
import { R4Keyring } from './r4-keyring.service.js';

const SCHEDULES: TemporalScheduleFact[] = [
  { scheduleId: 'acq-sweep', workflowType: 'acquisitionSweepWorkflow', taskQueue: 'understanding', mode: 'ENABLED' },
  { scheduleId: 'intent-sweep', workflowType: 'intentSweepWorkflow', taskQueue: 'understanding', mode: 'ENABLED' },
  { scheduleId: 'sanctions-refresh', workflowType: 'sanctionsRefreshWorkflow', taskQueue: 'understanding', mode: 'ENABLED' },
  { scheduleId: 'patents-cache-refresh', workflowType: 'patentsCacheRefreshWorkflow', taskQueue: 'understanding', mode: 'INTENTIONALLY_DISABLED_NO_EGRESS' },
];

function bindingFile(validForMs: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'r4-binding-'));
  const file = join(dir, 'deployment-binding.json');
  writeFileSync(
    file,
    JSON.stringify({
      backendSha: 'a'.repeat(40),
      growthosSha: 'b'.repeat(40),
      policyDigest: `sha256:${'c'.repeat(64)}`,
      validUntil: new Date(Date.now() + validForMs).toISOString(),
    }),
  );
  return file;
}

function build(options: {
  binding?: string;
  schedules?: TemporalScheduleProbe;
  backlog?: RevocationBacklogProbe;
}) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config = {
    NODE_ENV: 'development',
    R4_CAPABILITY_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    R4_CAPABILITY_KEY_ID: 'cap-test',
    R4_CAPABILITY_ISSUER: 'https://127.0.0.1:18446/',
    R4_CAPABILITY_AUDIENCE: 'global-backend:platform-temporal',
    R4_CAPABILITY_NAMESPACE: 'platform-automation',
    R4_CAPABILITY_TTL_SECONDS: 30,
    R4_DEPLOYMENT_BINDING_FILE: options.binding,
  } as unknown as AppConfig;
  const keyring = new R4Keyring(config);
  const facts = new PlatformFactsService(
    config,
    options.schedules ?? { read: async () => null },
    options.backlog ?? { read: async () => null },
  );
  return { keyring, facts, config };
}

const freshBacklog: RevocationBacklogProbe = {
  read: async (now: number): Promise<RevocationConsumerFact[]> =>
    SCHEDULES.map((s) => ({
      scheduleId: s.scheduleId,
      observedAt: now,
      validUntil: now + 20_000,
      undeliveredCount: 0,
      oldestUndeliveredCreatedAt: null,
    })),
};

describe('capability 端点', () => {
  it('事实齐全时返回可验签的 JOSE', async () => {
    const { keyring, facts, config } = build({
      binding: bindingFile(3600_000),
      schedules: { read: async () => SCHEDULES },
      backlog: freshBacklog,
    });
    await keyring.init();
    const controller = new CapabilityController(facts, new CapabilityIssuer(config, keyring));
    const jws = await controller.issue({ nonce: 'd'.repeat(32) });
    expect(jws.split('.')).toHaveLength(3);
  });

  it('绑定过期 / Temporal 不可用 / 消费者事实缺失 都返回 503 PLATFORM_CAPABILITY_UNAVAILABLE', async () => {
    const cases = [
      build({ binding: bindingFile(-1000), schedules: { read: async () => SCHEDULES }, backlog: freshBacklog }),
      build({ binding: bindingFile(3600_000), schedules: { read: async () => null }, backlog: freshBacklog }),
      build({ binding: bindingFile(3600_000), schedules: { read: async () => SCHEDULES }, backlog: { read: async () => [] } }),
    ];
    for (const { keyring, facts, config } of cases) {
      await keyring.init();
      const controller = new CapabilityController(facts, new CapabilityIssuer(config, keyring));
      await expect(controller.issue({ nonce: 'd'.repeat(32) })).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
  });

  it('nonce 非法时 400', async () => {
    const { keyring, facts, config } = build({ binding: bindingFile(3600_000) });
    await keyring.init();
    const controller = new CapabilityController(facts, new CapabilityIssuer(config, keyring));
    await expect(controller.issue({ nonce: 'nope' })).rejects.toThrow();
  });
});

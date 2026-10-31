import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import {
  TemporalScheduleProbeService,
  type ScheduleLister,
} from './temporal-schedule-probe.service.js';

const ALL = [
  { scheduleId: 'acq-sweep', workflowType: 'acquisitionSweepWorkflow', taskQueue: 'understanding' },
  { scheduleId: 'intent-sweep', workflowType: 'intentSweepWorkflow', taskQueue: 'understanding' },
  { scheduleId: 'sanctions-refresh', workflowType: 'sanctionsRefreshWorkflow', taskQueue: 'understanding' },
  { scheduleId: 'patents-cache-refresh', workflowType: 'patentsCacheRefreshWorkflow', taskQueue: 'understanding' },
];

const lister = (rows: typeof ALL | Error): ScheduleLister => ({
  list: async () => {
    if (rows instanceof Error) throw rows;
    return rows;
  },
});
const config = (enabled: boolean) => ({ R4_TEMPORAL_ENABLED: enabled } as unknown as AppConfig);

describe('Temporal schedule 探针', () => {
  it('未启用时返回 null（capability 503，线上现状不变）', async () => {
    const probe = new TemporalScheduleProbeService(config(false), lister(ALL));
    expect(await probe.read(Date.now())).toBeNull();
  });

  it('四个 schedule 齐全时给出四条事实，patents 标为刻意关闭', async () => {
    const probe = new TemporalScheduleProbeService(config(true), lister(ALL));
    const facts = await probe.read(Date.now());
    expect(facts).toHaveLength(4);
    expect(facts!.find((f) => f.scheduleId === 'patents-cache-refresh')?.mode).toBe(
      'INTENTIONALLY_DISABLED_NO_EGRESS',
    );
    expect(facts!.filter((f) => f.mode === 'ENABLED')).toHaveLength(3);
  });

  it('缺一个 schedule 或读取失败都返回 null（事实不完整即不可用）', async () => {
    const partial = new TemporalScheduleProbeService(config(true), lister(ALL.slice(0, 3)));
    expect(await partial.read(Date.now())).toBeNull();
    const failing = new TemporalScheduleProbeService(config(true), lister(new Error('boom')));
    expect(await failing.read(Date.now())).toBeNull();
  });
});

import { readTemporalMaterial, TemporalClientScheduleLister } from './temporal-schedule-probe.service.js';
import type { MachineTokenService } from './machine-token.service.js';

const noTokens = {} as MachineTokenService;

describe('真实 Temporal 客户端', () => {
  it('凭证不全时直接报错（探针据此判定事实不可用）', async () => {
    const lister = new TemporalClientScheduleLister({} as AppConfig, noTokens);
    await expect(lister.list()).rejects.toThrow(/凭证不全/);
  });

  it('连接材料：CA 与 reader 客户端证书齐全时才成立，缺一即报错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'r4-probe-'));
    const ca = join(dir, 'ca.pem');
    const crt = join(dir, 'client.pem');
    const key = join(dir, 'client.key');
    writeFileSync(ca, 'ca');
    writeFileSync(crt, 'crt');
    writeFileSync(key, 'key');
    const base = {
      R4_TEMPORAL_ADDRESS: '127.0.0.1:17233',
      R4_TEMPORAL_NAMESPACE: 'platform-automation',
      R4_TEMPORAL_SERVER_NAME: 'temporal-platform-reader',
      R4_TEMPORAL_TLS_CA_FILE: ca,
    };
    try {
      expect(() => readTemporalMaterial(base as unknown as AppConfig)).toThrow(/凭证不全/);
      const material = readTemporalMaterial({
        ...base,
        R4_TEMPORAL_TLS_CERT_FILE: crt,
        R4_TEMPORAL_TLS_KEY_FILE: key,
      } as unknown as AppConfig);
      expect(material.tls.serverNameOverride).toBe('temporal-platform-reader');
      expect(material.tls.clientCertPair.crt.toString()).toBe('crt');
      expect(material.tls.serverRootCACertificate.toString()).toBe('ca');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

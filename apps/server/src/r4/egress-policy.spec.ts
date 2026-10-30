import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { FileQuoteSource } from './egress-adapters.js';
import {
  EgressPolicyService,
  type ExpectedPolicy,
  type FenceRow,
  type FenceStore,
  type QuoteSource,
} from './egress-policy.service.js';

const POLICY = 'a'.repeat(64);
const ARTS: Record<string, string> = {
  'acq-sweep': 'b'.repeat(64),
  'intent-sweep': 'c'.repeat(64),
  'sanctions-refresh': 'd'.repeat(64),
};
const CAPS: Record<string, string> = { 'acq-sweep': '1', 'intent-sweep': '10000000', 'sanctions-refresh': '1' };

function rows(overrides: Partial<Record<string, Partial<FenceRow>>> = {}): FenceRow[] {
  return Object.keys(ARTS).map((scheduleId) => ({
    scheduleId,
    generation: 1,
    state: 'ACTIVE',
    policyArtifactSha256: POLICY,
    executionEnvelopeSha256: ARTS[scheduleId]!,
    requiredCapMicrousd: CAPS[scheduleId]!,
    ...(overrides[scheduleId] ?? {}),
  }));
}

function expected(): Map<string, ExpectedPolicy> {
  return new Map(
    Object.keys(ARTS).map((scheduleId) => [
      scheduleId,
      {
        policyRevision: POLICY,
        policyArtifactSha256: POLICY,
        executionEnvelopeSha256: ARTS[scheduleId]!,
        requiredCapMicrousd: CAPS[scheduleId]!,
      },
    ]),
  );
}

function build(storeRows: FenceRow[], install = vi.fn(async () => ({ generation: 2, replay: false }))) {
  const store: FenceStore = { readAll: async () => storeRows, install };
  const quotes: QuoteSource = { expected: async () => expected() };
  const prisma = { r4EgressInstallAudit: { create: vi.fn(async () => ({})) } };
  const service = new EgressPolicyService({} as AppConfig, store, quotes, prisma as never);
  return { service, store, prisma, install };
}

describe('egress 策略差异与安装', () => {
  it('干跑：现状与预期一致时全部 NONE，且 patents 恒为 BLOCKED', async () => {
    const { service } = build(rows());
    const result = await service.dryRun();
    expect(result.filter((r) => r.action === 'NONE')).toHaveLength(3);
    expect(result.find((r) => r.scheduleId === 'patents-cache-refresh')?.action).toBe('BLOCKED');
  });

  it('干跑：上限不一致时报 INSTALL', async () => {
    const { service } = build(rows({ 'intent-sweep': { requiredCapMicrousd: '1' } }));
    const intent = (await service.dryRun()).find((r) => r.scheduleId === 'intent-sweep');
    expect(intent?.action).toBe('INSTALL');
  });

  it('安装：带正确的 expectedGeneration 会调用安装并写审计', async () => {
    const { service, install, prisma } = build(rows({ 'intent-sweep': { requiredCapMicrousd: '1' } }));
    const result = await service.install('intent-sweep', 1, 'operator@test');
    expect(result.generation).toBe(2);
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: 'intent-sweep', expectedGeneration: 1, requiredCapMicrousd: '10000000' }),
    );
    expect(prisma.r4EgressInstallAudit.create).toHaveBeenCalled();
  });

  it('安装：generation 不匹配即拒绝', async () => {
    const { service, install } = build(rows({ 'intent-sweep': { requiredCapMicrousd: '1' } }));
    await expect(service.install('intent-sweep', 99, 'op')).rejects.toThrow(/generation/);
    expect(install).not.toHaveBeenCalled();
  });

  it('安装：patents 永不安装；DISABLED 行需人工', async () => {
    const a = build(rows());
    await expect(a.service.install('patents-cache-refresh', 1, 'op')).rejects.toThrow(/patents/);
    const b = build(rows({ 'acq-sweep': { state: 'DISABLED' } }));
    await expect(b.service.install('acq-sweep', 1, 'op')).rejects.toThrow(/DISABLED/);
  });
});

describe('期望值文件', () => {
  it('解析推导产物并跳过失败行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egress-'));
    const file = join(dir, 'expected.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ schedule: 'acq-sweep', policy: POLICY, envelope: ARTS['acq-sweep'], capMicrousd: '1' }),
        JSON.stringify({ schedule: 'intent-sweep', error: 'quote failed' }),
      ].join('\n'),
    );
    const source = new FileQuoteSource({ R4_EGRESS_EXPECTED_FILE: file } as unknown as AppConfig);
    const map = await source.expected();
    expect(map.size).toBe(1);
    expect(map.get('acq-sweep')?.requiredCapMicrousd).toBe('1');
  });

  it('非法摘要立即报错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'egress-'));
    const file = join(dir, 'bad.jsonl');
    writeFileSync(file, JSON.stringify({ schedule: 'acq-sweep', policy: 'zz', envelope: ARTS['acq-sweep'], capMicrousd: '1' }));
    const source = new FileQuoteSource({ R4_EGRESS_EXPECTED_FILE: file } as unknown as AppConfig);
    await expect(source.expected()).rejects.toThrow(/policy/);
  });
});

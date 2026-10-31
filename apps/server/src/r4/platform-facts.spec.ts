import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { bindingInstant, PlatformFactsService } from './platform-facts.service.js';

const NOW = 1_793_600_000_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function service(binding: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'r4-platform-facts-'));
  dirs.push(dir);
  const file = join(dir, 'deployment-binding.json');
  writeFileSync(file, JSON.stringify(binding));
  const config = { R4_DEPLOYMENT_BINDING_FILE: file } as unknown as AppConfig;
  return new PlatformFactsService(config, null as never, null as never);
}

describe('部署绑定时间戳', () => {
  it('epoch 毫秒与 ISO 字符串都能折算', () => {
    expect(bindingInstant(1793991688362)).toBe(1793991688362);
    expect(bindingInstant('2026-11-06T00:00:00.000Z')).toBe(Date.parse('2026-11-06T00:00:00.000Z'));
  });

  it('其他类型一律 NaN（调用方据此判不可用）', () => {
    expect(Number.isNaN(bindingInstant(undefined))).toBe(true);
    expect(Number.isNaN(bindingInstant(null))).toBe(true);
    expect(Number.isNaN(bindingInstant('not-a-date'))).toBe(true);
    expect(Number.isNaN(bindingInstant({}))).toBe(true);
  });
});

describe('部署绑定事实', () => {
  it('显式撤销的绑定不可用（capability fail closed）', () => {
    expect(() => service({
      backendSha: 'abc1234', validUntil: NOW + 86_400_000,
      revokedAt: new Date(NOW).toISOString(),
    }).readBinding(NOW)).toThrow(/显式撤销/);
  });

  it('正常绑定可读', () => {
    expect(service({ backendSha: 'abc1234', validUntil: NOW + 86_400_000 }).readBinding(NOW))
      .toMatchObject({ backendSha: 'abc1234' });
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import { BindingRevocationWatcher } from './binding-revocation-watcher.service.js';
import type { PlatformRevocationService } from './platform-revocation.service.js';

const NOW = 1_793_600_000_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(binding: unknown | string) {
  const dir = mkdtempSync(join(tmpdir(), 'r4-binding-revocation-'));
  dirs.push(dir);
  const file = join(dir, 'deployment-binding.json');
  writeFileSync(file, typeof binding === 'string' ? binding : JSON.stringify(binding));
  const config = {
    R4_REVOCATION_TRIGGER_ENABLED: true,
    PROCESS_ROLE: 'web',
    R4_DEPLOYMENT_BINDING_FILE: file,
  } as unknown as AppConfig;
  const findMany = vi.fn().mockResolvedValue([
    { scheduleId: 'acq-sweep', mode: 'ENABLED' },
    { scheduleId: 'intent-sweep', mode: 'ENABLED' },
    { scheduleId: 'sanctions-refresh', mode: 'ENABLED' },
  ]);
  const prisma = { r4PlatformPolicyState: { findMany } } as unknown as PrismaService;
  const revocations = { create: vi.fn().mockResolvedValue({ id: 'req' }) } as unknown as PlatformRevocationService;
  return { watcher: new BindingRevocationWatcher(config, prisma, revocations), revocations, findMany, file, dir };
}

describe('部署绑定显式撤销', () => {
  it('没有 revokedAt 时不产生任何请求', async () => {
    const { watcher, revocations } = fixture({ validUntil: NOW + 86_400_000 });
    await watcher.check(NOW);
    expect(revocations.create).not.toHaveBeenCalled();
  });

  it('revokedAt 存在时为每个 ENABLED schedule 产生带 dedupeKey 的请求', async () => {
    const { watcher, revocations } = fixture({
      validUntil: NOW + 86_400_000,
      revokedAt: new Date(NOW).toISOString(),
      revokeReasonCode: 'SECURITY_RESPONSE',
      revokedBy: 'ops@example.com',
      revokeNote: '部署凭据疑似泄露',
    });
    await watcher.check(NOW);
    expect(revocations.create).toHaveBeenCalledTimes(3);
    expect(revocations.create).toHaveBeenCalledWith(expect.objectContaining({
      scheduleId: 'acq-sweep',
      source: 'BINDING_REVOKED',
      reasonCode: 'SECURITY_RESPONSE',
      requestedBy: 'binding:ops@example.com',
      dedupeKey: `binding-revoked:acq-sweep:${new Date(NOW).toISOString()}`,
    }));
  });

  it('策略已 DISABLED 的 schedule 不再重复产生请求', async () => {
    const { watcher, revocations, findMany } = fixture({ revokedAt: NOW });
    findMany.mockResolvedValue([
      { scheduleId: 'acq-sweep', mode: 'DISABLED' },
      { scheduleId: 'intent-sweep', mode: 'ENABLED' },
      { scheduleId: 'sanctions-refresh', mode: 'ENABLED' },
    ]);
    await watcher.check(NOW);
    expect(revocations.create).toHaveBeenCalledTimes(2);
  });

  it('文件不可读或 JSON 损坏时不产生请求（≠撤销）', async () => {
    const broken = fixture('{not json');
    await broken.watcher.check(NOW);
    expect(broken.revocations.create).not.toHaveBeenCalled();
    const empty = fixture({ revokedAt: 'not-a-time' });
    await empty.watcher.check(NOW);
    expect(empty.revocations.create).not.toHaveBeenCalled();
  });

  it('非法 reason 码被忽略', async () => {
    const { watcher, revocations } = fixture({ revokedAt: NOW, revokeReasonCode: 'NOPE' });
    await watcher.check(NOW);
    expect(revocations.create).not.toHaveBeenCalled();
  });
});

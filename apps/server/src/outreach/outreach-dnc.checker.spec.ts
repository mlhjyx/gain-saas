import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { EngineOutreachDncChecker } from './outreach-dnc.checker.js';
import type { OutreachTenant } from './outreach-consent.service.js';

const tenant: OutreachTenant = {
  userId: 'user-a',
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'admin',
};
const EMAIL = 'buyer@example.de';

function hash(email: string): string {
  return createHash('sha256').update(email).digest('hex');
}

function checker(status: number, body: unknown) {
  const engine = {
    call: vi.fn(async () => ({ status, body, contentType: 'application/json', headers: {} })),
  };
  return new EngineOutreachDncChecker(engine as never, {} as AppConfig);
}

describe('EngineOutreachDncChecker（M2 步 11 fail-closed）', () => {
  it('200 且每条邮箱都有结果时返回命中原因', async () => {
    const service = checker(200, {
      data: { results: [{ emailHash: hash(EMAIL), suppressed: true, reasons: ['global:unsubscribe'] }] },
    });
    const result = await service.check(tenant, [EMAIL]);
    expect(result.get(EMAIL)).toEqual(['global:unsubscribe']);
  });

  it('负向：引擎 403 时抛错，不返回空结果（防 fail-open）', async () => {
    const service = checker(403, { error: { code: 'AUTH_ROLE_SCOPE_MISSING' } });
    await expect(service.check(tenant, [EMAIL])).rejects.toThrow(/HTTP 403/);
  });

  it('负向：引擎 5xx 时抛错', async () => {
    const service = checker(503, { error: { code: 'UNAVAILABLE' } });
    await expect(service.check(tenant, [EMAIL])).rejects.toThrow(/HTTP 503/);
  });

  it('负向：响应缺少 data.results 时抛错', async () => {
    const service = checker(200, { data: {} });
    await expect(service.check(tenant, [EMAIL])).rejects.toThrow(/data\.results/);
  });

  it('负向：响应缺少某个邮箱条目时抛错（不能把缺失当没命中）', async () => {
    const service = checker(200, { data: { results: [] } });
    await expect(service.check(tenant, [EMAIL])).rejects.toThrow(/缺少邮箱条目/);
  });

  it('负向：条目形态不合法时抛错', async () => {
    const service = checker(200, {
      data: { results: [{ emailHash: hash(EMAIL), reasons: 'nope' }] },
    });
    await expect(service.check(tenant, [EMAIL])).rejects.toThrow(/emailHash\/reasons/);
  });
});

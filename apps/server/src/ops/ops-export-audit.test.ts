import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { OpsExportThrottle } from './ops-export-throttle.js';
import { OpsService } from './ops.service.js';

function makeService(options: { rows?: number; throttleLimit?: number } = {}) {
  const rowCount = options.rows ?? 3;
  const rows = Array.from({ length: rowCount }, (_, i) => ({ source_key: `src-${i}` }));
  const query = vi.fn(async () => rows);
  const database = {
    db: {
      query,
      withWorkspace: async (_workspaceId: string, fn: (client: { query: () => Promise<{ rows: unknown[] }> }) => unknown) =>
        fn({ query: async () => ({ rows }) }),
    },
    writable: vi.fn(async () => ({ query })),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const config = { OPS_EXPORT_HOURLY_LIMIT: options.throttleLimit ?? 10 } as AppConfig;
  const service = new OpsService(
    config,
    database as never,
    {} as never,
    audit as never,
    {} as never,
    new OpsExportThrottle(options.throttleLimit ?? 10),
  );
  return { service, query, audit };
}

describe('OpsService 导出审计与限流', () => {
  it('导出写审计（动作/筛选/行数/截断标记）', async () => {
    const { service, audit } = makeService({ rows: 3 });
    const result = await service.exportSources('op-1', 'ACTIVE');
    expect(result.filename).toContain('sources');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        realm: 'ops',
        actorId: 'op-1',
        action: 'export.sources',
        detail: expect.objectContaining({ rows: 3, truncated: false, filters: { status: 'ACTIVE' } }),
      }),
    );
  });

  it('命中 5000 行上限时标记 truncated', async () => {
    const { service, audit } = makeService({ rows: 5000 });
    await service.exportFetches('op-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'export.fetches', detail: expect.objectContaining({ truncated: true }) }),
    );
  });

  it('超出小时限额返回 429 EXPORT_RATE_LIMITED', async () => {
    const { service } = makeService({ throttleLimit: 1 });
    await service.exportSources('op-1');
    const error = await service.exportSources('op-1').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect(((error as HttpException).getResponse() as { error: { code: string } }).error.code).toBe(
      'EXPORT_RATE_LIMITED',
    );
  });

  it('leads 导出同样审计', async () => {
    const { service, audit } = makeService({ rows: 2 });
    // leads 走 withWorkspace，桩里 writable 返回同一 query
    await service.exportLeads('op-1', '11111111-1111-4111-8111-111111111111', 'recommended');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'export.leads',
        target: '11111111-1111-4111-8111-111111111111',
        detail: expect.objectContaining({ rows: 2, filters: expect.objectContaining({ queue: 'recommended' }) }),
      }),
    );
  });
});

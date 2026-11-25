import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { OpsExportThrottle } from './ops-export-throttle.js';
import { OpsService } from './ops.service.js';

function makeHarness(options: {
  hasOwnerPool?: boolean;
  queryImpl?: (sql: string, params?: unknown[]) => unknown[];
  ownerQueryImpl?: (sql: string, params?: unknown[]) => unknown[];
} = {}) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => options.queryImpl?.(sql, params) ?? []);
  const ownerQuery = vi.fn(async (sql: string, params?: unknown[]) => options.ownerQueryImpl?.(sql, params) ?? []);
  const db = {
    ownerPool: options.hasOwnerPool === false ? null : ({} as unknown),
    query,
    ownerQuery,
  };
  const database = {
    db,
    writable: vi.fn(async () => db),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const service = new OpsService(
    { OPS_EXPORT_HOURLY_LIMIT: 10 } as AppConfig,
    database as never,
    {} as never,
    audit as never,
    {} as never,
    new OpsExportThrottle(10),
  );
  return { service, query, ownerQuery, audit };
}

function assertSelectOnly(queryCalls: Array<[string, ...unknown[]]>) {
  for (const [sql] of queryCalls) {
    expect(sql.trim().toUpperCase()).toMatch(/^SELECT\b/);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  }
}

describe('OpsService monitored_source & data_provider writes (ownerQuery isolation)', () => {
  it('acquireNow runs SELECT on db.query and UPDATE on db.ownerQuery', async () => {
    const { service, query, ownerQuery, audit } = makeHarness({
      queryImpl: () => [{ id: 's-1', source_key: 'sec-edgar', status: 'ACTIVE', next_fetch_at: null }],
      ownerQueryImpl: () => [{ id: 's-1', source_key: 'sec-edgar', status: 'ACTIVE', next_fetch_at: '2026-11-26T00:00:00Z' }],
    });

    const result = await service.acquireNow('s-1', 'ops-1');

    expect(result.source).toMatchObject({ id: 's-1', source_key: 'sec-edgar' });
    assertSelectOnly(query.mock.calls);
    expect(ownerQuery).toHaveBeenCalledTimes(1);
    expect(ownerQuery.mock.calls[0]![0]).toMatch(/UPDATE monitored_source SET next_fetch_at/i);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ realm: 'ops', action: 'source.acquire-now' }));
  });

  it('acquireNow throws 404 NOT_FOUND and 409 NOT_ACTIVE without calling ownerQuery', async () => {
    const missing = makeHarness({ queryImpl: () => [] });
    await expect(missing.service.acquireNow('s-missing', 'ops-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(missing.ownerQuery).not.toHaveBeenCalled();

    const paused = makeHarness({
      queryImpl: () => [{ id: 's-1', source_key: 'sec-edgar', status: 'PAUSED', next_fetch_at: null }],
    });
    await expect(paused.service.acquireNow('s-1', 'ops-1')).rejects.toBeInstanceOf(ConflictException);
    expect(paused.ownerQuery).not.toHaveBeenCalled();
  });

  it('setSourceStatus runs SELECT on db.query and UPDATE on db.ownerQuery', async () => {
    const { service, query, ownerQuery, audit } = makeHarness({
      queryImpl: () => [{ id: 's-1', source_key: 'sec-edgar', status: 'ACTIVE' }],
      ownerQueryImpl: () => [{ id: 's-1', source_key: 'sec-edgar', status: 'PAUSED' }],
    });

    const result = await service.setSourceStatus('s-1', 'PAUSED', 'ops-1');

    expect(result.source).toEqual({ id: 's-1', source_key: 'sec-edgar', status: 'PAUSED' });
    assertSelectOnly(query.mock.calls);
    expect(ownerQuery).toHaveBeenCalledTimes(1);
    expect(ownerQuery.mock.calls[0]![0]).toMatch(/UPDATE monitored_source SET status = \$2/i);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ realm: 'ops', action: 'source.status' }));
  });

  it('createSource runs duplicate SELECT on db.query and INSERT on db.ownerQuery', async () => {
    const { service, query, ownerQuery, audit } = makeHarness({
      queryImpl: () => [],
      ownerQueryImpl: () => [{ id: 's-new', provider_key: 'edgar', source_key: 'edgar-10k', label: '10-K' }],
    });

    const result = await service.createSource(
      { providerKey: 'edgar', sourceKey: 'edgar-10k', label: '10-K' },
      'ops-1',
    );

    expect(result.source).toMatchObject({ source_key: 'edgar-10k' });
    assertSelectOnly(query.mock.calls);
    expect(ownerQuery).toHaveBeenCalledTimes(1);
    expect(ownerQuery.mock.calls[0]![0]).toMatch(/INSERT INTO monitored_source/i);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ realm: 'ops', action: 'source.create' }));
  });

  it('createSource rejects duplicate sourceKey and invalid input without calling ownerQuery', async () => {
    const bad = makeHarness();
    await expect(bad.service.createSource({ providerKey: '', sourceKey: 'bad key' }, 'ops-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(bad.ownerQuery).not.toHaveBeenCalled();

    const dup = makeHarness({ queryImpl: () => [{ source_key: 'edgar-10k' }] });
    await expect(
      dup.service.createSource({ providerKey: 'edgar', sourceKey: 'edgar-10k', label: '10-K' }, 'ops-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(dup.ownerQuery).not.toHaveBeenCalled();
  });

  it('updateSource runs SELECT on db.query and UPDATE on db.ownerQuery', async () => {
    const { service, query, ownerQuery, audit } = makeHarness({
      queryImpl: () => [{ id: 's-1', source_key: 'edgar-10k', label: 'Old' }],
      ownerQueryImpl: () => [{ id: 's-1', source_key: 'edgar-10k', label: 'New' }],
    });

    const result = await service.updateSource('s-1', { label: 'New' }, 'ops-1');

    expect(result.source).toMatchObject({ label: 'New' });
    assertSelectOnly(query.mock.calls);
    expect(ownerQuery).toHaveBeenCalledTimes(1);
    expect(ownerQuery.mock.calls[0]![0]).toMatch(/UPDATE monitored_source SET/i);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ realm: 'ops', action: 'source.update' }));
  });

  it('deleteSource checks HAS_DATA via db.query and deletes via db.ownerQuery', async () => {
    const used = makeHarness({
      queryImpl: (sql) => (sql.includes('source_fetch') ? [{ n: '2' }] : [{ id: 's-1', source_key: 's', status: 'PAUSED' }]),
    });
    await expect(used.service.deleteSource('s-1', 'ops-1')).rejects.toBeInstanceOf(ConflictException);
    expect(used.ownerQuery).not.toHaveBeenCalled();

    const ok = makeHarness({
      queryImpl: (sql) => (sql.includes('source_fetch') ? [{ n: '0' }] : [{ id: 's-1', source_key: 's', status: 'PAUSED' }]),
      ownerQueryImpl: () => [{ source_key: 's' }],
    });
    const res = await ok.service.deleteSource('s-1', 'ops-1');
    expect(res).toEqual({ deleted: 's' });
    assertSelectOnly(ok.query.mock.calls);
    expect(ok.ownerQuery).toHaveBeenCalledTimes(1);
  });

  it('throws 400 OWNER_REQUIRED when ownerPool is null across all write methods', async () => {
    const h = makeHarness({
      hasOwnerPool: false,
      queryImpl: (sql) => {
        if (sql.includes('source_fetch')) return [{ n: '0' }];
        if (sql.includes('WHERE source_key =')) return [];
        if (sql.includes('data_provider')) return [{ key: 'edgar', status: 'ENABLED' }];
        return [{ id: 's-1', source_key: 'edgar-10k', status: 'ACTIVE' }];
      },
    });

    const cases: Array<() => Promise<unknown>> = [
      () => h.service.acquireNow('s-1', 'ops-1'),
      () => h.service.setSourceStatus('s-1', 'PAUSED', 'ops-1'),
      () => h.service.createSource({ providerKey: 'edgar', sourceKey: 'edgar-10k', label: '10-K' }, 'ops-1'),
      () => h.service.updateSource('s-1', { label: 'New' }, 'ops-1'),
      () => h.service.deleteSource('s-1', 'ops-1'),
      () => h.service.setProviderStatus('edgar', 'DISABLED', 'ops-1'),
    ];

    for (const run of cases) {
      const err = await run().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        error: { code: 'OWNER_REQUIRED' },
      });
    }
    expect(h.ownerQuery).not.toHaveBeenCalled();
  });
});

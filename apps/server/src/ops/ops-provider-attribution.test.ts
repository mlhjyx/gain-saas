import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { OpsExportThrottle } from './ops-export-throttle.js';
import { OpsService } from './ops.service.js';

function makeService(rows: Record<string, unknown>[]) {
  const workspaceCalls: string[] = [];
  const clientQuery = vi.fn(async (sql: string) => {
    if (/raw_source_record/.test(sql)) return { rows };
    return { rows: [] };
  });
  const database = {
    db: {
      query: vi.fn(async () => []),
      withWorkspace: async (
        workspaceId: string,
        fn: (client: { query: typeof clientQuery }) => unknown,
      ) => {
        workspaceCalls.push(workspaceId);
        return fn({ query: clientQuery });
      },
    },
    writable: vi.fn(async () => ({ query: vi.fn(async () => []) })),
  };
  const service = new OpsService(
    {} as AppConfig,
    database as never,
    {} as never,
    { record: vi.fn(async () => undefined) } as never,
    {} as never,
    new OpsExportThrottle(10),
  );
  return { service, clientQuery, workspaceCalls };
}

describe('OpsService 数据源归因（Q33 PR-1）', () => {
  it('按工作空间返回 provider 漏斗（原始→公司→管线→快判→深判正→推荐）', async () => {
    const funnel = [
      {
        provider_key: 'public_web',
        raw_records: 517,
        cost_cents: 0,
        companies: 412,
        in_pipeline: 380,
        quick_judged: 120,
        deep_positive: 34,
        recommended: 9,
      },
      {
        provider_key: 'wikidata',
        raw_records: 88,
        cost_cents: 0,
        companies: 88,
        in_pipeline: 60,
        quick_judged: 22,
        deep_positive: 7,
        recommended: 2,
      },
    ];
    const { service, clientQuery, workspaceCalls } = makeService(funnel);
    const rows = await service.providerAttribution('11111111-1111-4111-8111-111111111111');
    expect(rows).toEqual(funnel);
    expect(workspaceCalls).toEqual(['11111111-1111-4111-8111-111111111111']);
    const sql = String(clientQuery.mock.calls[0]?.[0] ?? '');
    expect(sql).toMatch(/raw_source_record/);
    expect(sql).toMatch(/identity_link/);
    expect(sql).toMatch(/discovery_company_job/);
    expect(sql).toMatch(/queue = 'recommended'/);
  });

  it('要求合法 workspace id（运营域 RLS，跨空间聚合不做）', async () => {
    const { service } = makeService([]);
    await expect(service.providerAttribution('not-a-uuid')).rejects.toMatchObject({
      response: { error: { code: 'VALIDATION' } },
    });
  });
});

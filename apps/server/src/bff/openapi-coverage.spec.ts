import { describe, expect, it } from 'vitest';
import { BFF_ROUTES } from './routes.js';
import {
  COVERAGE_BASELINE_PATH,
  ENGINE_LOCK_PATH,
  ENGINE_SPEC_PATH,
  bffRouteCoverage,
  loadJson,
  normalizeEnginePath,
  routeKey,
  type CoverageBaseline,
  type OpenApiDocument,
} from './openapi-coverage.js';

/**
 * PR-12：BFF 路由表 ↔ 固定引擎合同的覆盖清单闸门。
 *
 * RED（本 PR 之前）：没有任何测试把 BFF 路由与固定合同对照，新增的引擎端点可以
 * 悄悄透传而合同里没有对应操作；GREEN：下面是机器校验的清单与漂移守卫。
 */

describe('BFF ↔ engine OpenAPI coverage (PR-12)', () => {
  const spec = loadJson<OpenApiDocument>(ENGINE_SPEC_PATH);
  const baseline = loadJson<CoverageBaseline>(COVERAGE_BASELINE_PATH);
  const lock = loadJson<{ pinnedAt?: string }>(ENGINE_LOCK_PATH);

  it('baseline records which engine contract it was generated against', () => {
    expect(baseline.pinnedAt).toBe(lock.pinnedAt);
  });

  it('every BFF route is either present in the pinned contract or explicitly listed', () => {
    const { covered, uncovered } = bffRouteCoverage(BFF_ROUTES, spec);

    expect(covered.length + uncovered.length).toBe(BFF_ROUTES.length);
    // 双向一致：新增未覆盖路由 → 红（先升级合同或登记）；合同升级后已覆盖条目 → 红（重生成清单）。
    expect([...uncovered].sort()).toEqual([...baseline.uncovered].sort());
  });

  it('baseline entries are sorted, unique, and still map to real BFF routes', () => {
    expect(baseline.uncovered).toEqual([...new Set(baseline.uncovered)].sort());
    const routeKeys = new Set(BFF_ROUTES.map((route) => routeKey(route.method, route.enginePath)));
    expect(baseline.uncovered.filter((key) => !routeKeys.has(key))).toEqual([]);
  });

  it('BFF route table has no duplicate method + saasPath rows', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const route of BFF_ROUTES) {
      const key = `${route.method} ${route.saasPath}`;
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    expect(duplicates).toEqual([]);
  });

  it('normalizes version prefixes and path templates into one comparable shape', () => {
    expect(normalizeEnginePath('/api/v1/companies/{companyId}')).toBe('/companies/:companyId');
    expect(normalizeEnginePath('/api/v1/icps')).toBe('/icps');
    expect(normalizeEnginePath('/health')).toBe('/health');
    expect(routeKey('get', '/health')).toBe('GET /health');
  });

  it('pins the coverage counts so the checklist cannot drift silently', () => {
    const { covered, uncovered } = bffRouteCoverage(BFF_ROUTES, spec);
    expect({
      bffRoutes: BFF_ROUTES.length,
      covered: covered.length,
      uncovered: uncovered.length,
    }).toEqual({ bffRoutes: 84, covered: 50, uncovered: 34 });
  });
});

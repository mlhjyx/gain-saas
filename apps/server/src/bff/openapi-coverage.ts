import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BffRoute } from './routes.js';

/**
 * PR-12：BFF 路由 ↔ 固定引擎 OpenAPI 的覆盖清单。
 *
 * BFF_ROUTES 的 enginePath 必须能在 packages/engine-client 的固定合同里找到对应操作；
 * 固定合同是**显式落后**于引擎 head 的（见 packages/engine-client/README.md），所以
 * 早于合同的端点登记在 openapi-coverage.baseline.json 里，而不是悄悄漏检：
 *  - 新增 BFF 路由 → 合同里没有、baseline 里也没有 → 测试红，必须升级合同或登记理由；
 *  - 合同升级（pin 的 pinnedAt 变化）→ 测试红，强制重新生成 baseline 并复核清单。
 */

export interface OpenApiDocument {
  paths?: Record<string, Record<string, unknown>>;
}

export interface CoverageBaseline {
  schemaVersion: string;
  pinnedAt: string;
  reason: string;
  uncovered: string[];
}

// 仅测试使用：vitest 的 cwd 是 apps/server（与 `pnpm --filter @gain-saas/server test` 一致）。
const serverRoot = process.cwd();
export const ENGINE_SPEC_PATH = join(serverRoot, '../../packages/engine-client/src/openapi.json');
export const ENGINE_LOCK_PATH = join(
  serverRoot,
  '../../packages/engine-client/engine-contract.lock.json',
);
export const COVERAGE_BASELINE_PATH = join(serverRoot, 'src/bff/openapi-coverage.baseline.json');

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

/** 引擎 OpenAPI 路径（/api/v1 前缀、{param} 模板）→ 与 BFF enginePath 相同的形态。 */
export function normalizeEnginePath(path: string): string {
  return path.replace(/^\/api\/v1(?=\/|$)/u, '').replace(/\{([A-Za-z]+)\}/gu, ':$1');
}

export function routeKey(method: string, enginePath: string): string {
  return `${method.toUpperCase()} ${enginePath}`;
}

export function engineOperationKeys(spec: OpenApiDocument): Set<string> {
  const keys = new Set<string>();
  for (const [path, operations] of Object.entries(spec.paths ?? {})) {
    const normalized = normalizeEnginePath(path);
    for (const method of Object.keys(operations)) {
      if (HTTP_METHODS.has(method.toLowerCase())) {
        keys.add(routeKey(method, normalized));
      }
    }
  }
  return keys;
}

export interface BffRouteCoverage {
  covered: string[];
  uncovered: string[];
}

/** 逐条 BFF 路由对照固定合同：covered = 合同里有对应操作。 */
export function bffRouteCoverage(
  routes: readonly BffRoute[],
  spec: OpenApiDocument,
): BffRouteCoverage {
  const operations = engineOperationKeys(spec);
  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const route of routes) {
    const key = routeKey(route.method, route.enginePath);
    (operations.has(key) ? covered : uncovered).push(key);
  }
  return { covered, uncovered };
}

export function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

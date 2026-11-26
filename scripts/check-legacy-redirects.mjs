#!/usr/bin/env node
/**
 * P5b-24 / Wave B2：历史深链 redirect 表的静态核对。
 *
 * 规则（P5b-17/G10）：被删除/合并的路由保留 redirect ≥2 个发布版本；redirect 的
 * 目标必须仍是已定义的真实路由路径（忽略 legacy.ts 自身），否则深链会跳到 404。
 *
 * 支持形态：
 * - `LEGACY_REDIRECTS` 中的 `{ name, path, to }`（含多行、带 `?query` 目标、动态段 `:param`）
 * - `LEGACY_GROWTH_TAB_REDIRECTS` 中的 `/growth?tab=<key>` 分流表
 * 解析刻意保持轻量（正则），不引入 vite 依赖；漏网形态由 test 的变异用例兜底。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const PATH_LINE_RE = /^\s*path:\s*'([^']+)'/u;
const LEGACY_ENTRY_RE =
  /\{\s*name:\s*'[^']+',\s*path:\s*'([^']+)',\s*to:\s*'([^']+)',?\s*\}/gu;
const GROWTH_TAB_BLOCK_RE =
  /LEGACY_GROWTH_TAB_REDIRECTS(?:\s*:\s*[^=]+)?\s*=\s*\{([\s\S]*?)\};/u;
const TAB_KV_RE = /(?:['"]([^'"]+)['"]|([A-Za-z0-9_-]+))\s*:\s*'([^']+)'/gu;

/**
 * 提取已定义路径：绝对路径（'/x'）作为父级记入，紧跟其后的相对子路径
 * （'members' → '/x/members'）按父级组合。两层级足以覆盖本仓 router 结构；
 * 更深层级若出现，加用例再扩。
 */
export function extractPaths(source) {
  const paths = [];
  let parent = null;
  for (const line of source.split('\n')) {
    const match = PATH_LINE_RE.exec(line);
    if (!match) continue;
    const value = match[1];
    if (value.startsWith('/')) {
      parent = value;
      paths.push(value);
    } else if (parent) {
      paths.push(`${parent}/${value}`);
    }
  }
  return paths;
}

export function extractLegacyRedirects(source) {
  const entries = [...source.matchAll(LEGACY_ENTRY_RE)].map((match) => ({
    path: match[1],
    to: match[2],
  }));

  const growthBlock = GROWTH_TAB_BLOCK_RE.exec(source);
  if (growthBlock) {
    for (const match of growthBlock[1].matchAll(TAB_KV_RE)) {
      const tabKey = match[1] ?? match[2];
      const target = match[3];
      entries.push({
        path: `/growth?tab=${tabKey}`,
        to: target,
      });
    }
  }

  return entries;
}

/**
 * 去掉目标路径的 `?query` / `#hash`，只保留 pathname 用于路由表核对。
 */
export function stripQueryAndHash(target) {
  return target.split(/[?#]/u)[0] ?? '';
}

/**
 * 判断单条动态路由模板是否与目标 pathname 逐段匹配：
 * - 段数必须一致（避免 `/outreach/campaigns` 误命中 `/outreach/campaigns/:campaignId`）
 * - 静态段精确相等；`:param` 段匹配任意非空段（无论实值 `123` 或占位符 `:campaignId`）。
 */
function matchesDynamicPattern(pathname, defined) {
  if (!defined.includes(':')) return false;
  const targetSegs = pathname.split('/').filter(Boolean);
  const definedSegs = defined.split('/').filter(Boolean);
  if (targetSegs.length !== definedSegs.length) return false;
  return definedSegs.every((seg, idx) =>
    seg.startsWith(':') ? targetSegs[idx].length > 0 : seg === targetSegs[idx],
  );
}

/** 目标是否命中已定义路径（支持 `?query` 目标与动态段匹配）。 */
export function targetExists(target, definedPaths) {
  const pathname = stripQueryAndHash(target);
  if (!pathname) return false;
  if (definedPaths.includes(pathname)) return true;
  for (const defined of definedPaths) {
    if (matchesDynamicPattern(pathname, defined)) return true;
  }
  return false;
}

export function checkRedirects({ definedPaths, redirects }) {
  const missing = [];
  const duplicateSources = new Set();
  const seen = new Set();
  for (const entry of redirects) {
    if (seen.has(entry.path)) duplicateSources.add(entry.path);
    seen.add(entry.path);
    if (!targetExists(entry.to, definedPaths)) {
      missing.push(entry);
    }
  }
  return { missing, duplicateSources: [...duplicateSources] };
}

export function run(rootDir = repoRoot) {
  const modulesPath = join(rootDir, 'apps/web/src/router/routes/modules');
  const files = readdirSync(modulesPath).filter((name) => name.endsWith('.ts'));
  const definedPaths = [];
  let redirects = [];
  for (const file of files) {
    const source = readFileSync(join(modulesPath, file), 'utf8');
    if (file === 'legacy.ts') {
      redirects = extractLegacyRedirects(source);
      continue;
    }
    definedPaths.push(...extractPaths(source));
  }
  const result = checkRedirects({ definedPaths, redirects });
  return { ...result, redirectCount: redirects.length, definedCount: definedPaths.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = run();
  if (result.missing.length > 0 || result.duplicateSources.length > 0) {
    for (const entry of result.missing) {
      console.error(`LEGACY_REDIRECT_TARGET_MISSING ${entry.path} -> ${entry.to}`);
    }
    for (const path of result.duplicateSources) {
      console.error(`LEGACY_REDIRECT_DUPLICATE_SOURCE ${path}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `legacy redirects OK：${result.redirectCount} 条 redirect，目标均在 ${result.definedCount} 个已定义路径中`,
    );
  }
}

#!/usr/bin/env node
/**
 * P5b-24：历史深链 redirect 表的静态核对。
 *
 * 规则（P5b-17/G10）：被删除/合并的路由保留 redirect ≥2 个发布版本；redirect 的
 * 目标必须仍是已定义的路由路径，否则深链会跳到 404。
 *
 * 做法：从 router/routes/modules 下提取所有 `path: '...'` 与 legacy 表的
 * `{ path, to }` 条目；每个 to 必须命中某个静态路径（动态段按模式前缀匹配）。
 * 解析刻意保持轻量（正则），不引入 vite 依赖；漏网形态由 test 的变异用例兜底。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const modulesDir = join(repoRoot, 'apps/web/src/router/routes/modules');

const PATH_LINE_RE = /^\s*path:\s*'([^']+)'/u;
const LEGACY_ENTRY_RE = /\{\s*name:\s*'[^']+',\s*path:\s*'([^']+)',\s*to:\s*'([^']+)'\s*\}/gu;

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
  return [...source.matchAll(LEGACY_ENTRY_RE)].map((match) => ({
    path: match[1],
    to: match[2],
  }));
}

/** 目标是否命中已定义路径：静态相等，或目标是动态路由模式的前缀实例（/x/:id → /x/123）。 */
export function targetExists(target, definedPaths) {
  if (definedPaths.includes(target)) return true;
  for (const defined of definedPaths) {
    if (!defined.includes(':')) continue;
    const prefix = defined.split('/:')[0];
    if (prefix && (target === prefix || target.startsWith(`${prefix}/`))) return true;
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
    definedPaths.push(...extractPaths(source));
    if (file === 'legacy.ts') redirects = extractLegacyRedirects(source);
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

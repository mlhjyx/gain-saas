#!/usr/bin/env node
/**
 * 日期格式红线机检（v3.0 ch07 QW14）。
 *
 * 租户界面只能通过 @gain-saas/shared 的 formatDate/formatDateTime（或 DateText 组件）
 * 展示时间；直接调用 toLocaleString / toLocaleDateString / toLocaleTimeString 会随
 * 浏览器 locale 与系统时区漂移，连审计截图都对不上。
 *
 * 豁免：
 *   - apps/web/src/views/ops/**（平台运营台是技术工作面，允许保留原始时间戳展示）；
 *   - 行内注释 `// date-lint-disable: 理由`（必须写理由）。
 *
 * 用法：node scripts/lint-date-format.mjs [repoRoot]
 * 退出码：0 = 通过；1 = 命中。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TO_LOCALE_RE = /\btoLocale(?:String|DateString|TimeString)\b/;
const EXEMPT_RE = /\/\/\s*date-lint-disable(?::\s*(.+))?$/;

const SKIP_DIRS = new Set(['node_modules', 'dist', 'ops']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else if (entry.isFile() && /\.(vue|ts)$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

export function lintSource(source) {
  const violations = [];
  source.split('\n').forEach((line, index) => {
    if (!TO_LOCALE_RE.test(line)) return;
    if (EXEMPT_RE.test(line.trim()) || EXEMPT_RE.test(line)) return;
    violations.push({ line: index + 1, snippet: line.trim().slice(0, 160) });
  });
  return violations;
}

function main() {
  const root = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
  const targets = walk(join(root, 'apps/web/src'));
  const failures = [];
  for (const file of targets) {
    const result = lintSource(readFileSync(file, 'utf8'));
    for (const v of result) {
      failures.push(`${relative(root, file)}:${v.line} ${v.snippet}`);
    }
  }
  if (failures.length > 0) {
    console.error('✗ 日期格式红线：视图不得直接调用 toLocaleString/toLocaleDateString/toLocaleTimeString');
    console.error('  用 @gain-saas/shared 的 formatDate/formatDateTime 或 DateText 组件替代（QW14）。');
    for (const item of failures) console.error(`  ${item}`);
    return 1;
  }
  console.log(`✓ 日期格式检查通过：${targets.length} 个文件未发现直接 toLocale* 调用`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}

#!/usr/bin/env node
/**
 * 2026-11-12 审计 L-8：SaaS workflow 的第三方 action 必须按 40 位 commit SHA 钉住。
 * 本地 action（`./...`）与 `docker://` 不检查。新增 moving tag 会让 CI 红。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = '.github/workflows';
const files = readdirSync(directory)
  .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
  .sort();
const issues = [];
for (const file of files) {
  const text = readFileSync(join(directory, file), 'utf8');
  for (const match of text.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gmu)) {
    const reference = match[1];
    if (reference.startsWith('./') || reference.startsWith('docker://')) {
      continue;
    }
    const at = reference.lastIndexOf('@');
    const sha = at >= 0 ? reference.slice(at + 1) : '';
    if (!/^[0-9a-f]{40}$/iu.test(sha)) {
      issues.push(`${file}: ${reference}`);
    }
  }
}
if (issues.length > 0) {
  console.error('[action-pins] unpinned third-party actions:');
  for (const issue of issues) console.error(`  ${issue}`);
  process.exit(1);
}
console.log(`[action-pins] ${files.length} workflow(s) pinned to 40-hex SHAs`);

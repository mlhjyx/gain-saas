import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * vue-i18n 把 `@` 当链接消息语法（`@:key` / `@.mod:key`），`{'@'}` 才是字面量。
 * 2026-11-03 曾因占位文案里写了裸 `sales@example.com`，/onboarding 渲染时抛
 * INVALID_LINKED_FORMAT（错误码 10），整页白屏。这里在 CI 里把这类消息拦在合入前。
 */
const LOCALES_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../apps/web/src/locales/langs',
);

function localeFiles(): string[] {
  return readdirSync(LOCALES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((dir) =>
      readdirSync(join(LOCALES_ROOT, dir.name))
        .filter((file) => file.endsWith('.json'))
        .map((file) => join(LOCALES_ROOT, dir.name, file)),
    );
}

function walkMessages(node: unknown, path: string[], found: Array<{ key: string; value: string }>) {
  if (typeof node === 'string') {
    found.push({ key: path.join('.'), value: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkMessages(item, [...path, String(index)], found));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) walkMessages(value, [...path, key], found);
  }
}

function literalOrLinkedAt(value: string): boolean {
  // 合法的 `@` 只允许出现在 ICU 字面量插值 {'@'} 里；字面量整体先剔除再检查剩余 `@`。
  return !value.replaceAll("{'@'}", '').includes('@');
}

describe('locale 文案与 vue-i18n 语法兼容', () => {
  it('消息里的 @ 必须是 {\'@\'} 字面量，不能是裸 @（链接消息语法）', () => {
    const offenders: string[] = [];
    for (const file of localeFiles()) {
      const messages: Array<{ key: string; value: string }> = [];
      walkMessages(JSON.parse(readFileSync(file, 'utf8')), [], messages);
      for (const { key, value } of messages) {
        if (!literalOrLinkedAt(value)) offenders.push(`${file}:${key} => ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * P5b-24：redirect 核对器的变异测试——解析/命中/缺失/重复四类行为都要钉住。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkRedirects,
  extractLegacyRedirects,
  extractPaths,
  targetExists,
} from './check-legacy-redirects.mjs';

test('提取静态路径（含子路由组合）与 legacy 条目', () => {
  const source = `
    path: '/settings',
    children: [
      {
        path: 'members',
      },
      {
        path: 'audit',
      },
    ],
    path: '/companies',
  `;
  assert.deepEqual(extractPaths(source), ['/settings', '/settings/members', '/settings/audit', '/companies']);
  assert.deepEqual(
    extractLegacyRedirects(`{ name: 'A', path: '/dashboard', to: '/workspace' },`),
    [{ path: '/dashboard', to: '/workspace' }],
  );
});

test('目标命中：静态相等或动态模式前缀实例', () => {
  const defined = ['/workspace', '/leads/:leadId'];
  assert.equal(targetExists('/workspace', defined), true);
  assert.equal(targetExists('/leads/123', defined), true);
  assert.equal(targetExists('/leads', defined), true);
  assert.equal(targetExists('/settings/members', ['/settings', '/settings/members']), true);
  assert.equal(targetExists('/ghost', defined), false);
});

test('缺失目标与重复 source 都会被报出来', () => {
  const result = checkRedirects({
    definedPaths: ['/workspace'],
    redirects: [
      { path: '/a', to: '/workspace' },
      { path: '/a', to: '/ghost' },
    ],
  });
  assert.deepEqual(result.missing, [{ path: '/a', to: '/ghost' }]);
  assert.deepEqual(result.duplicateSources, ['/a']);
});

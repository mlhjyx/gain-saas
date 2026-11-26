/**
 * P5b-24 / Wave B2：redirect 核对器的变异测试——解析/带 query 目标/tab 分流/动态段/缺失/重复都要钉住。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkRedirects,
  extractLegacyRedirects,
  extractPaths,
  run,
  targetExists,
} from './check-legacy-redirects.mjs';

test('提取静态路径（含子路由组合）、legacy 条目（含多行）与 /growth tab 分流表', () => {
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

  const legacySource = `
    export const LEGACY_REDIRECTS = [
      { name: 'A', path: '/dashboard', to: '/workspace' },
      {
        name: 'B',
        path: '/campaigns/:campaignId',
        to: '/outreach/campaigns/:campaignId',
      },
    ];
    export const LEGACY_GROWTH_TAB_REDIRECTS: Record<string, string> = {
      campaigns: '/outreach?tab=campaigns',
      outreach: '/outreach?tab=batches',
      reviews: '/leads?view=reviews',
      metrics: '/analytics',
    };
  `;
  assert.deepEqual(extractLegacyRedirects(legacySource), [
    { path: '/dashboard', to: '/workspace' },
    { path: '/campaigns/:campaignId', to: '/outreach/campaigns/:campaignId' },
    { path: '/growth?tab=campaigns', to: '/outreach?tab=campaigns' },
    { path: '/growth?tab=outreach', to: '/outreach?tab=batches' },
    { path: '/growth?tab=reviews', to: '/leads?view=reviews' },
    { path: '/growth?tab=metrics', to: '/analytics' },
  ]);
});

test('目标命中：静态路径、带 ?query 目标与严格动态段匹配', () => {
  const defined = ['/workspace', '/outreach', '/outreach/campaigns/:campaignId', '/leads', '/leads/:leadId'];
  assert.equal(targetExists('/workspace', defined), true);
  assert.equal(targetExists('/outreach?tab=campaigns', defined), true);
  assert.equal(targetExists('/outreach?tab=batches', defined), true);
  assert.equal(targetExists('/leads?view=reviews', defined), true);
  assert.equal(targetExists('/outreach/campaigns/:campaignId', defined), true);
  assert.equal(targetExists('/outreach/campaigns/camp-123?from=mail', defined), true);
  assert.equal(targetExists('/leads/123', defined), true);
  assert.equal(targetExists('/settings/members', ['/settings', '/settings/members']), true);

  // 未定义路径与段数不匹配的动态前缀必须判为不存在
  assert.equal(targetExists('/outreach/campaigns', ['/outreach/campaigns/:campaignId']), false);
  assert.equal(targetExists('/outreach/campaigns/123/extra', defined), false);
  assert.equal(targetExists('/ghost?tab=1', defined), false);
});

test('缺失目标与重复 source（含重复 /growth tab）都会被报出来', () => {
  const result = checkRedirects({
    definedPaths: ['/workspace', '/outreach'],
    redirects: [
      { path: '/a', to: '/workspace' },
      { path: '/a', to: '/ghost?tab=1' },
      { path: '/growth?tab=metrics', to: '/outreach?tab=campaigns' },
      { path: '/growth?tab=metrics', to: '/missing-analytics' },
    ],
  });
  assert.deepEqual(result.missing, [
    { path: '/a', to: '/ghost?tab=1' },
    { path: '/growth?tab=metrics', to: '/missing-analytics' },
  ]);
  assert.deepEqual(result.duplicateSources, ['/a', '/growth?tab=metrics']);
});

test('当前仓库的 legacy redirect 表全部合法且无重复', () => {
  const result = run();
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.duplicateSources, []);
  assert.ok(result.redirectCount >= 17, `预期至少 17 条 redirect（含 6 条 /growth tab 分流），实际 ${result.redirectCount}`);
});

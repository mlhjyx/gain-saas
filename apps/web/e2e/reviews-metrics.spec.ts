/**
 * v3.0：判定复核队列与度量页（引擎 P3 J17 / ch01 PR-04 的浏览器侧主链）。
 *
 * 判定复核：列表 → 详情抽屉（判据与证据）→ 认领 → 结论（FIT + 理由）；
 * 度量：VRIC 成对趋势（含缺侧 null 的断点）→ 指标目录 → 观测分页 → 粒度切换。
 * 全部走 BFF mock，不需要引擎与数据库。
 */
import type { MockHandler } from './support/mock-backend';

import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const NOW = '2026-11-09T08:00:00.000Z';
const DUE = new Date(Date.now() + 30 * 86_400_000).toISOString();

const TASK = {
  companyName: 'Muster Metallbau GmbH',
  dueAt: DUE,
  id: 'jr-1',
  judgmentRecordId: 'record-1',
  priority: 0,
  reason: 'UNKNOWN',
  status: 'queued',
  verdictAtJudge: 'UNKNOWN',
};

const STATS = {
  byPriority: { '0': 1, '1': 2 },
  byReason: { UNKNOWN: 4 },
  byStatus: { in_review: 1, queued: 3, resolved: 2 },
  overturn: { overturned: 1, rate: 0.5, resolved: 2 },
  windowDays: 7,
};

const DETAIL = {
  canonicalCompanyId: 'c1',
  createdAt: NOW,
  criteria: [
    {
      applicable: true,
      evidence: [
        {
          fetched_at: NOW,
          kind: 'website',
          span: '官网产品页：金属加工与批发',
          url: 'https://muster-metallbau.de/produkte',
        },
      ],
      id: 'C1_MATERIAL',
      label: 'pass',
      rationale: '官网列出与目标品类一致的金属制品。',
      score: 8,
    },
    {
      applicable: true,
      evidence: [],
      id: 'C2_ROLE',
      label: 'unclear',
      rationale: '贸易角色在现有证据中不够清晰。',
      score: null,
    },
  ],
  failureCode: null,
  id: 'record-1',
  modelRequested: 'judge-v2',
  verdict: 'UNKNOWN',
};

/**
 * 引擎分页信封 `{data, page}` 必须原样 fulfill：mock 的 set(普通值) 会再包一层 {data}，
 * 这会把 page 包进 data 里——这里直接按 BFF 透传的真实形状应答。
 */
function rawJson(make: () => unknown): MockHandler {
  return async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify(make()),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  };
}

function vricValue(value: number) {
  return {
    ciHigh: null,
    ciLow: null,
    denominator: 100_000,
    metricVersion: 1,
    numerator: value * 100,
    refreshedAt: NOW,
    sampleN: 500,
    value,
  };
}

const VRIC_ROWS = [
  { bucket: '2026-11-08', plus: vricValue(2.4), stratumKey: 'ALL', strict: vricValue(1.2) },
  // 缺侧：PLUS 在该桶没有数据 → null，折线必须断开而不是按 0 画。
  { bucket: '2026-11-09', plus: null, stratumKey: 'ALL', strict: vricValue(1.5) },
];

const CATALOG = [
  {
    definition: '每 1,000 个匹配账户中可正式触达的人数（严格口径）。',
    effectiveFrom: '2026-11-09T00:00:00.000Z',
    metricId: 'T0-001',
    name: 'vric_1000_strict',
    owner: 'data-eng',
    status: 'ACTIVE',
    tier: 'T0',
    unit: 'count_per_1000',
    version: 1,
  },
  {
    definition: '观测通道拆分与内部运营口径。',
    effectiveFrom: '2026-11-09T00:00:00.000Z',
    metricId: 'T0-002',
    name: 'vric_1000_plus',
    owner: 'data-eng',
    status: 'DRAFT',
    tier: 'T0',
    unit: 'count_per_1000',
    version: 1,
  },
];

const OBSERVATION = {
  ciHigh: 1.9,
  ciLow: 1.1,
  computedAt: NOW,
  denominator: 100_000,
  id: 'obs-1',
  metricId: 'T0-001',
  metricVersion: 1,
  numerator: 150,
  sampleN: 500,
  stratum: {},
  value: 1.5,
  windowEnd: '2026-11-09T00:00:00.000Z',
  windowStart: '2026-11-08T00:00:00.000Z',
};

const ROLLUP = {
  bucket: '2026-11-09',
  ciHigh: 1.9,
  ciLow: 1.1,
  metricId: 'T0-001',
  metricVersion: 1,
  numerator: 150,
  denominator: 100_000,
  refreshedAt: NOW,
  sampleN: 500,
  stratum: {},
  stratumKey: 'ALL',
  value: 1.5,
};

test('判定复核：列表 → 详情 → 认领 → 结论', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/judgment-reviews', { items: [TASK], nextCursor: null });
  backend.set('GET', '/judgments/stats', STATS);
  backend.set('GET', '/judgments/record-1', DETAIL);
  backend.set('POST', '/judgment-reviews/jr-1/claim', { status: 'in_review' });
  backend.set('POST', '/judgment-reviews/jr-1/resolve', {
    goldenLabelId: 'label-1',
    recordId: 'record-2',
  });

  await loginAs(page);
  await page.goto('/growth?tab=reviews');

  await expect(page.getByRole('heading', { level: 2, name: '判定复核' })).toBeVisible();
  const row = page.locator('.rv__table tbody tr').first();
  await expect(row).toContainText('Muster Metallbau GmbH');
  await expect(row).toContainText('P0 紧急');
  await expect(row).toContainText('机器无法判定');
  await expect(row).toContainText('剩 ');

  // 详情抽屉：判据 + 证据链接
  await row.getByRole('button', { name: '查看' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('材质与品类匹配', { exact: true })).toBeVisible();
  await expect(dialog.getByText('贸易角色', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('link', { name: /官网产品页/ })).toHaveAttribute(
    'href',
    'https://muster-metallbau.de/produkte',
  );

  // 键盘可达：Esc 关闭抽屉，焦点回到触发按钮
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row.getByRole('button', { name: '查看' })).toBeFocused();
  await row.getByRole('button', { name: '查看' }).click();
  await expect(dialog).toBeVisible();

  // 认领：queued → in_review
  await dialog.getByRole('button', { name: '认领任务' }).click();
  await expect.poll(() => backend.callsTo('POST', '/judgment-reviews/jr-1/claim').length).toBe(1);
  await expect(dialog.getByText('已认领，请给出复核结论。')).toBeVisible();

  // 结论：FIT + 理由
  await dialog.getByRole('radio', { name: '符合', exact: true }).check();
  await dialog.getByLabel('理由（可选）').fill('官网产品页与目标品类一致');
  await dialog.getByRole('button', { name: '提交结论' }).click();
  await expect.poll(() => backend.callsTo('POST', '/judgment-reviews/jr-1/resolve').length).toBe(1);
  const resolve = backend.callsTo('POST', '/judgment-reviews/jr-1/resolve')[0]!;
  expect(resolve.body).toMatchObject({ note: '官网产品页与目标品类一致', verdict: 'FIT' });

  await expect(page.getByText('复核结论已提交，队列已更新。')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('判定复核：空态与筛选参数', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/judgment-reviews', { items: [], nextCursor: null });
  backend.set('GET', '/judgments/stats', {
    byPriority: {},
    byReason: {},
    byStatus: {},
    overturn: { overturned: 0, rate: null, resolved: 0 },
    windowDays: 7,
  });

  await loginAs(page);
  await page.goto('/growth?tab=reviews');

  await expect(page.getByText('队列已清空')).toBeVisible();
  await page.getByLabel('状态').selectOption('queued');
  await expect
    .poll(() => backend.callsTo('GET', '/judgment-reviews').at(-1)?.query.status)
    .toBe('queued');
});

test('度量：VRIC 成对趋势、指标目录与观测/聚合表', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set(
    'GET',
    '/metrics/vric',
    rawJson(() => ({ data: VRIC_ROWS, page: { has_more: true, next_cursor: null } })),
  );
  backend.set('GET', '/metrics/catalog', rawJson(() => ({ data: CATALOG, page: { has_more: false, next_cursor: null } })));
  backend.set(
    'GET',
    '/metrics/observations',
    rawJson(() => ({ data: [OBSERVATION], page: { has_more: true, next_cursor: 'cursor-2' } })),
  );
  backend.set(
    'GET',
    '/metrics/rollups',
    rawJson(() => ({ data: [ROLLUP], page: { has_more: false, next_cursor: null } })),
  );

  await loginAs(page);
  await page.goto('/growth?tab=metrics');

  await expect(page.getByRole('heading', { level: 2, name: '度量' })).toBeVisible();
  // 最新桶摘要：缺侧（PLUS=null）显示 —，不以 0 冒充
  const summary = page.locator('.mt__summary');
  await expect(summary).toContainText('最新桶：2026-11-09');
  await expect(summary).toContainText('严格口径（STRICT） 1.500');
  await expect(summary).toContainText('放宽口径（PLUS） —');
  await expect(page.getByText('某侧没有数据时折线断开——空白代表缺数据，不代表 0。')).toBeVisible();
  await expect(page.locator('.mt__chart canvas').first()).toBeVisible({ timeout: 15_000 });

  // 指标目录
  await expect(page.getByRole('cell', { name: 'T0-001' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'T0 北极星' }).first()).toBeVisible();
  await expect(page.locator('.mt__badge, .gs-badge', { hasText: '生效中' }).first()).toBeVisible();

  // 观测：切 tab 才拉数据；行与游标入口可见
  await page.getByRole('tab', { name: '观测' }).click();
  await expect.poll(() => backend.callsTo('GET', '/metrics/observations').length).toBe(1);
  const observationRow = page.locator('table tbody tr').filter({ hasText: 'T0-001' }).first();
  await expect(observationRow).toContainText('1.500');
  await expect(page.getByRole('button', { name: '加载更多' })).toBeVisible();
  expect(backend.callsTo('GET', '/metrics/observations')[0]?.query.limit).toBe('50');

  // 聚合：按周重新拉取
  await page.getByRole('tab', { name: '聚合' }).click();
  await expect.poll(() => backend.callsTo('GET', '/metrics/rollups').length).toBe(1);
  await page.getByLabel('粒度').last().selectOption('weekly');
  await expect
    .poll(() => backend.callsTo('GET', '/metrics/rollups').at(-1)?.query.granularity)
    .toBe('weekly');

  // VRIC 粒度切换
  await page.getByLabel('粒度').first().selectOption('weekly');
  await expect
    .poll(() => backend.callsTo('GET', '/metrics/vric').at(-1)?.query.granularity)
    .toBe('weekly');
});

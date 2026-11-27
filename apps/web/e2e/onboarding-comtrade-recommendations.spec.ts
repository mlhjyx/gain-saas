import type { Page } from '@playwright/test';

import { expect, test } from '@playwright/test';

import { errorPayload, installMockBackend, loginAs } from './support/mock-backend';

const COMPANY_ID = 'company-comtrade-e2e';
const RECOMMENDATIONS = `/companies/${COMPANY_ID}/market-recommendations`;
const READY = {
  started: true,
  preview: {
    companyId: COMPANY_ID,
    failure: null,
    industry: { options: [], raw: null, suggested: null },
    markets: [],
    name: '示例新能源股份公司',
    pagesAnalyzed: 3,
    products: [{ name: '光伏组件', sourceUrl: null }],
    state: 'ready',
    status: 'REVIEW',
    website: 'https://example.org',
  },
};

const TRADE = {
  companyId: COMPANY_ID,
  isRecommendationOnly: true,
  basis: {
    dataSource: 'un_comtrade_baseline_v1',
    hsCodes: [{ code: '854143', label: 'Photovoltaic modules', labelZh: '光伏组件' }],
    inferredFrom: 'offerings_and_industry',
    referenceYear: 2024,
  },
  recommendations: [
    { code: 'NL', hsCodes: ['854143'], importVolumeUsd: 8_420_000_000, name: '荷兰', yoyGrowthPct: 6.4 },
    { code: 'DE', hsCodes: ['854143'], importVolumeUsd: 6_180_000_000, name: '德国', yoyGrowthPct: 12.1 },
    { code: 'ES', hsCodes: ['854143'], importVolumeUsd: 4_390_000_000, name: '西班牙', yoyGrowthPct: 9.8 },
    { alreadySelected: true, code: 'IT', hsCodes: ['854143'], importVolumeUsd: 3_950_000_000, name: '意大利', yoyGrowthPct: 15.6 },
    { code: 'BR', hsCodes: ['854143'], importVolumeUsd: 3_620_000_000, name: '巴西', yoyGrowthPct: 11.4 },
    { code: 'PL', hsCodes: ['854143'], importVolumeUsd: 2_480_000_000, name: '波兰', yoyGrowthPct: 13.2 },
  ],
};

const MONTHLY_TRADE = {
  ...TRADE,
  basis: {
    ...TRADE.basis,
    coverage: 12,
    dataSource: 'un_comtrade_live',
    referencePeriod: '202608',
    referenceYear: 2026,
    shareBasis: 'comparable_reporters',
  },
  recommendations: [{ code: 'DE', importVolumeUsd: 28_719_300, name: '德国', yoyGrowthPct: -4.8 }],
};

async function startPreview(page: Page): Promise<void> {
  await loginAs(page);
  await page.locator('[data-gs="setup-website"]').fill('example.org');
  await page.locator('[data-gs="setup-start"]').click();
}

test('建档展示 HS、年份、进口额和同比，单选与批量加入保留手工选择', async ({ page }) => {
  const backend = await installMockBackend(page, { onboardingComplete: false });
  backend.set('POST', '/onboarding/preview', READY);
  backend.set('GET', RECOMMENDATIONS, TRADE);
  await startPreview(page);

  const panel = page.locator('[data-gs="comtrade-recommendations"]');
  const picker = page.locator('[data-gs="setup-markets"]');
  const italy = panel.locator('[data-gs="comtrade-market-IT"]');
  await expect(italy).toBeVisible();
  await expect(panel).toContainText('854143');
  await expect(panel).toContainText('2024');
  await expect(panel).toContainText('历史基准');
  await expect(italy).toContainText('$3.95B');
  await expect(italy).toContainText('+15.6%');
  await expect(italy).toHaveAttribute('aria-pressed', 'false');
  await expect(picker.locator('.ant-select-selection-item')).toHaveCount(0);

  await picker.click();
  await page.locator('.ant-select-item-option', { hasText: '加拿大 (CA)' }).first().click();
  await page.keyboard.press('Escape');
  await italy.focus();
  await italy.press('Enter');
  await expect(italy).toHaveAttribute('aria-pressed', 'true');
  await expect(picker.locator('.ant-select-selection-item')).toHaveCount(2);

  await panel.locator('[data-gs="comtrade-add-all"]').click();
  await expect(picker.locator('.ant-select-selection-item')).toHaveCount(7);
  await picker.locator('.ant-select-selection-item', { hasText: '意大利 (IT)' })
    .locator('.ant-select-selection-item-remove').click();
  await expect(italy).toHaveAttribute('aria-pressed', 'false');
  await expect(picker).toContainText('加拿大 (CA)');

  await page.setViewportSize({ height: 844, width: 390 });
  await expect(panel.locator('[data-gs="comtrade-market-NL"]')).toBeVisible();
  expect(await panel.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await page.locator('[data-gs="setup-save"]').click();
  await expect.poll(() => backend.callsTo('POST', '/onboarding/company')[0]?.body).toMatchObject({
    targetMarkets: ['CA', 'NL', 'DE', 'ES', 'BR', 'PL'],
  });
  expect(backend.callsTo('POST', '/discovery-runs')).toHaveLength(0);
  expect(backend.callsTo('POST', '/tasks')).toHaveLength(0);
});

test('分析期间显示通用数据与缺失指标，分析完成后更新依据并保留已选市场', async ({ page }) => {
  const backend = await installMockBackend(page, { onboardingComplete: false });
  const running = { ...READY, preview: { ...READY.preview, products: [], state: 'running' } };
  backend.set('POST', '/onboarding/preview', running);
  backend.set('GET', '/onboarding/preview', running);
  backend.set('GET', RECOMMENDATIONS, {
    ...TRADE,
    basis: {
      ...TRADE.basis,
      hsCodes: [{ code: '847989', label: 'Industrial machinery' }],
      inferredFrom: 'fallback_general',
    },
    recommendations: [
      { code: 'DE', importVolumeUsd: null, name: '德国', yoyGrowthPct: -5.2 },
      { code: 'FR', importVolumeUsd: 0, name: '法国' },
    ],
  });
  await startPreview(page);

  const panel = page.locator('[data-gs="comtrade-recommendations"]');
  const germany = panel.locator('[data-gs="comtrade-market-DE"]');
  const france = panel.locator('[data-gs="comtrade-market-FR"]');
  await expect(panel).toContainText('847989');
  await expect(panel).toContainText('通用贸易数据');
  await expect(germany).toContainText('进口额暂无');
  await expect(germany).toContainText('-5.2%');
  await expect(france).toContainText('$0');
  await expect(france).toContainText('同比暂无');

  await germany.click();
  backend.set('GET', RECOMMENDATIONS, TRADE);
  backend.set('GET', '/onboarding/preview', READY);
  await expect(panel).toContainText('854143');
  await expect(panel).not.toContainText('通用贸易数据');
  await expect(germany).toHaveAttribute('aria-pressed', 'true');
});

test('批量加入按剩余位置补充，已选市场达到二十个时禁止继续加入', async ({ page }) => {
  const backend = await installMockBackend(page, { onboardingComplete: false });
  const selected = [
    'US', 'CA', 'MX', 'BR', 'GB', 'FR', 'IT', 'ES', 'BE', 'PL',
    'SE', 'NO', 'DK', 'FI', 'CH', 'AT', 'CZ', 'TR', 'RU',
  ];
  backend.set('GET', '/workspace/context', {
    allowedActions: [],
    onboarding: { companyId: COMPANY_ID, complete: false },
    user: backend.session.user,
    workspace: backend.session.workspaces[0],
  });
  backend.set('GET', '/companies', [{
    id: COMPANY_ID, name: READY.preview.name, status: 'DRAFT', targetMarkets: selected,
  }]);
  backend.set('GET', '/onboarding/preview', READY);
  backend.set('GET', RECOMMENDATIONS, TRADE);
  await loginAs(page);

  const picker = page.locator('[data-gs="setup-markets"]');
  const panel = page.locator('[data-gs="comtrade-recommendations"]');
  await expect(picker.locator('.ant-select-selection-item')).toHaveCount(19);
  await panel.locator('[data-gs="comtrade-add-all"]').click();
  await expect(picker.locator('.ant-select-selection-item')).toHaveCount(20);
  await expect(panel.locator('[data-gs="comtrade-market-NL"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.locator('[data-gs="comtrade-market-DE"]')).toBeDisabled();
  await expect(page.getByText(/最多.*20.*市场/)).toBeVisible();

  await page.locator('[data-gs="setup-save"]').click();
  await expect.poll(() => backend.callsTo('POST', '/onboarding/company')[0]?.body).toMatchObject({
    targetMarkets: [...selected, 'NL'],
  });
});

test('月度贸易快照展示报告月份、同月同比和覆盖市场', async ({ page }) => {
  const backend = await installMockBackend(page, { onboardingComplete: false });
  backend.set('POST', '/onboarding/preview', READY);
  backend.set('GET', RECOMMENDATIONS, MONTHLY_TRADE);
  await startPreview(page);

  const panel = page.locator('[data-gs="comtrade-recommendations"]');
  const germany = panel.locator('[data-gs="comtrade-market-DE"]');
  await expect(panel).toContainText('2026 年 8 月');
  await expect(panel).toContainText('2025 年同月同比');
  await expect(panel).toContainText('覆盖 12 个可比市场');
  await expect(panel).toContainText('UN Comtrade');
  await expect(germany).toContainText('月进口额 $28.72M');
  await expect(germany).toContainText('-4.8%');
  await expect(germany).not.toContainText('年进口额');
  await expect(germany).toHaveAttribute('aria-pressed', 'false');
});

test('市场推荐返回 502 后可就地重试，手选市场和建档继续可用', async ({ page }) => {
  const backend = await installMockBackend(page, { onboardingComplete: false });
  backend.set('POST', '/onboarding/preview', READY);
  backend.set('GET', RECOMMENDATIONS, async ({ route }) => {
    await route.fulfill({ json: errorPayload('UPSTREAM_UNAVAILABLE'), status: 502 });
    return true;
  });
  const firstFailure = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith(RECOMMENDATIONS) && response.status() === 502,
  );
  await startPreview(page);
  await firstFailure;

  const error = page.locator('[data-gs="comtrade-load-error"]');
  const picker = page.locator('[data-gs="setup-markets"]');
  await expect(error.getByRole('alert')).toHaveText('目标市场推荐读取失败');
  await expect(page.locator('[data-gs="setup-save"]')).toBeEnabled();
  await picker.click();
  await page.locator('.ant-select-item-option', { hasText: '加拿大 (CA)' }).first().click();
  await page.keyboard.press('Escape');
  await expect(picker).toContainText('加拿大 (CA)');

  let completeRetry!: () => void;
  const retryResponse = new Promise<void>((resolve) => { completeRetry = resolve; });
  backend.set('GET', RECOMMENDATIONS, async ({ route }) => {
    await retryResponse;
    await route.fulfill({ json: { data: MONTHLY_TRADE } });
    return true;
  });
  await error.getByRole('button', { name: '重试' }).click();
  await expect(page.locator('[data-gs="comtrade-loading"]')).toBeVisible();
  await expect(page.locator('[data-gs="setup-save"]')).toBeEnabled();
  completeRetry();

  const panel = page.locator('[data-gs="comtrade-recommendations"]');
  await expect(panel).toContainText('2026 年 8 月');
  await expect(error).toHaveCount(0);
  await expect(picker).toContainText('加拿大 (CA)');
  await panel.locator('[data-gs="comtrade-market-DE"]').click();
  await page.locator('[data-gs="setup-save"]').click();
  await expect.poll(() => backend.callsTo('POST', '/onboarding/company')[0]?.body).toMatchObject({
    targetMarkets: ['CA', 'DE'],
  });
});

test('旧推荐请求迟到失败时保留同一企业新的月度结果', async ({ page }) => {
  const backend = await installMockBackend(page, { onboardingComplete: false });
  const running = { ...READY, preview: { ...READY.preview, products: [], state: 'running' } };
  backend.set('POST', '/onboarding/preview', running);
  backend.set('GET', '/onboarding/preview', running);
  let completeOldRequest!: () => void;
  const oldResponse = new Promise<void>((resolve) => { completeOldRequest = resolve; });
  backend.set('GET', RECOMMENDATIONS, async ({ backend, route }) => {
    if (backend.callsTo('GET', RECOMMENDATIONS).length === 1) {
      await oldResponse;
      await route.fulfill({ json: errorPayload('UPSTREAM_UNAVAILABLE'), status: 502 });
    } else {
      await route.fulfill({ json: { data: MONTHLY_TRADE } });
    }
    return true;
  });

  await startPreview(page);
  await expect.poll(() => backend.callsTo('GET', RECOMMENDATIONS).length).toBe(1);
  backend.set('GET', '/onboarding/preview', READY);
  const panel = page.locator('[data-gs="comtrade-recommendations"]');
  await expect(panel).toContainText('2026 年 8 月', { timeout: 15_000 });
  const oldFailure = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith(RECOMMENDATIONS) && response.status() === 502,
  );
  completeOldRequest();
  await (await oldFailure).finished();
  await expect(panel).toContainText('2026 年 8 月');
  await expect(page.locator('[data-gs="comtrade-load-error"]')).toHaveCount(0);
});

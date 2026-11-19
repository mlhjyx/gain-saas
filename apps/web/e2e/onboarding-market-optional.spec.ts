/**
 * B0：未指定市场也可保存资料——真实浏览器全组合矩阵。
 *
 * 12 个状态族 × 2 应用语言（zh-CN/en-US）× 2 实际主题（light/dark）×
 * 2 实际尺寸（1440×900 / 390×844）= 96 格，不抽样；每格跑该族全部子场景。
 * 语言与主题沿应用自身偏好持久化切换（登录页 AuthTools → updatePreferences），
 * 不靠浏览器 locale/colorScheme 假设；onboarding 页无顶栏按钮也不影响。
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { installMockBackend, type MockBackend } from './support/mock-backend';

// 设计独立体验需要成功格的原始 trace，不只失败格。
test.use({ trace: 'on' });

type Lang = 'zh-CN' | 'en-US';
type Theme = 'light' | 'dark';
type Width = 'wide' | 'narrow';

const LANGS: Lang[] = ['zh-CN', 'en-US'];
const THEMES: Theme[] = ['light', 'dark'];
const WIDTHS: Record<Width, { height: number; width: number }> = {
  wide: { height: 900, width: 1440 },
  narrow: { height: 844, width: 390 },
};

const TEXT = {
  'zh-CN': {
    addProduct: '添加',
    companyName: '企业名称',
    failureTitle: '官网理解没有完成',
    loading: '正在载入…',
    manual: '没有官网，手动填写',
    marketOptionDe: '德国 (DE)',
    marketsLabel: '目标市场',
    productPlaceholder: '输入一个产品后按回车添加',
    productsLimit: '最多添加 5 个产品',
    start: '开始理解',
    submit: '完成建档',
    submitFailed: '建档失败，请稍后重试',
    suggestedPrefix: '官网提到：',
    switchManual: '改为手动填写',
    title: '完善公司档案',
    waitingTitle: '正在阅读你的官网…',
  },
  'en-US': {
    addProduct: 'Add',
    companyName: 'Company name',
    failureTitle: 'We could not finish reading your website',
    loading: 'Loading…',
    manual: 'No website — fill in manually',
    marketOptionDe: 'Germany (DE)',
    marketsLabel: 'Target markets',
    productPlaceholder: 'Type a product and press Enter',
    productsLimit: 'Up to 5 products',
    start: 'Read my website',
    submit: 'Finish setup',
    submitFailed: 'Setup failed, please try again later',
    suggestedPrefix: 'Mentioned on your website:',
    switchManual: 'Fill in manually',
    title: 'Complete your company profile',
    waitingTitle: 'Reading your website…',
  },
} as const;

/** 与引擎 understanding-preview 同形的局部 fixture（只覆盖本用例关心的字段）。 */
function preview(overrides: Record<string, unknown> = {}) {
  return {
    companyId: 'company-e2e',
    name: 'E2E 测试公司',
    website: 'https://example.org',
    status: 'REVIEW',
    state: 'ready',
    failure: null,
    pagesAnalyzed: 4,
    industry: {
      raw: '精密机械制造',
      suggested: {
        raw: '精密机械制造',
        code: '28',
        label: '通用及专用设备制造',
        labelEn: 'Manufacture of machinery',
        matched: true,
      },
      options: [
        { code: '28', label: '通用及专用设备制造', labelEn: 'Manufacture of machinery', nace: ['28'] },
        { code: '25', label: '金属制品制造', labelEn: 'Fabricated metal products', nace: ['25'] },
      ],
    },
    products: [
      {
        name: 'LED 灯具',
        source: 'understanding',
        sourceUrl: 'https://example.org/products',
        evidence: 'LED lighting',
      },
    ],
    markets: [
      {
        code: 'DE',
        name: '德国',
        labelEn: 'Germany',
        evidence: 'Export to Germany',
        sourceUrl: 'https://example.org/about',
      },
    ],
    updatedAt: '2026-11-10T08:00:00Z',
    ...overrides,
  };
}

const NOT_STARTED_PREVIEW = preview({
  state: 'not_started',
  status: 'DRAFT',
  pagesAnalyzed: 0,
  industry: { raw: null, suggested: null, options: [] },
  products: [],
  markets: [],
  website: null,
});

const READY_EMPTY_MARKETS = preview({ markets: [] });

function productsFixture(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    name: `产品-${index + 1}`,
    source: 'understanding',
    sourceUrl: `https://example.org/products/${index + 1}`,
    evidence: `product ${index + 1}`,
  }));
}

type Cell = { family: string; lang: Lang; theme: Theme; width: Width };

function text(cell: Cell) {
  return TEXT[cell.lang];
}

async function enterAs(
  page: Page,
  cell: Cell,
  options: { role?: 'admin' | 'member' } = {},
): Promise<MockBackend> {
  await page.setViewportSize(WIDTHS[cell.width]);
  const backend = await installMockBackend(page, {
    onboardingComplete: false,
    ...(options.role ? { role: options.role } : {}),
  });
  await page.goto('/auth/login');
  // 应用自身的偏好持久化：登录页 AuthTools 的语言/主题按钮（与顶栏同一机制）。
  if (cell.lang === 'en-US') {
    await page.getByRole('button', { name: 'Switch to English' }).click();
  }
  if (cell.theme === 'dark') {
    await page.getByRole('button', { name: 'Switch to dark' }).click();
  }
  await page.waitForTimeout(250); // 偏好保存（debounce 150ms）落盘后再登录
  await page.locator('input[type="email"]').fill('e2e@gainos.local');
  await page.locator('input[type="password"]').fill('e2e-password-123');
  await page.locator('button.g-submit').click();
  await page.waitForURL(/\/onboarding/);
  await expect(page.getByRole('heading', { name: text(cell).title })).toBeVisible();
  return backend;
}

/** 保存成功会跳 /workspace；同格再验下一子场景时重置 mock 完成态并回到向导。 */
async function reenter(page: Page, cell: Cell, backend: MockBackend): Promise<void> {
  backend.onboardingComplete = false;
  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { name: text(cell).title })).toBeVisible();
}

async function assertEnvironment(page: Page, cell: Cell): Promise<void> {
  const t = text(cell);
  await expect(page.getByRole('heading', { name: t.title })).toBeVisible();
  const htmlClass = await page.evaluate(() => document.documentElement.className);
  expect(htmlClass.includes('dark'), `主题应为 ${cell.theme}：${htmlClass}`).toBe(
    cell.theme === 'dark',
  );
  const bg = await page.evaluate(() => {
    const target = document.querySelector('.onboarding') ?? document.body;
    return getComputedStyle(target).backgroundColor;
  });
  const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  expect(match, `背景应为计算色：${bg}`).toBeTruthy();
  const luminance =
    0.2126 * Number(match![1]) + 0.7152 * Number(match![2]) + 0.0722 * Number(match![3]);
  if (cell.theme === 'dark') expect(luminance).toBeLessThan(80);
  else expect(luminance).toBeGreaterThan(150);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `横向溢出 ${overflow}px`).toBeLessThanOrEqual(1);
}

function submitButton(page: Page, cell: Cell) {
  return page.getByRole('button', { name: text(cell).submit });
}

function marketSelect(page: Page, cell: Cell) {
  return page.locator('.field').filter({ hasText: text(cell).marketsLabel }).locator('.ant-select');
}

async function fillNameOnStart(page: Page, name: string): Promise<void> {
  await page.locator('.onboarding-section input').first().fill(name);
}

async function enterManual(page: Page, cell: Cell): Promise<void> {
  await fillNameOnStart(page, 'E2E 测试公司');
  await page.getByRole('button', { name: text(cell).manual }).click();
  await expect(submitButton(page, cell)).toBeVisible();
}

async function startReadyPreview(page: Page, cell: Cell): Promise<void> {
  await page.locator('input[placeholder*="https://"]').fill('https://example.org');
  await page.getByRole('button', { name: text(cell).start }).click();
  await expect(submitButton(page, cell)).toBeVisible();
}

async function addProduct(page: Page, cell: Cell, name: string): Promise<void> {
  const input = page.getByPlaceholder(text(cell).productPlaceholder);
  await input.fill(name);
  await input.press('Enter');
}

async function selectMarketDe(page: Page, cell: Cell): Promise<void> {
  await marketSelect(page, cell).click();
  await page.locator('.ant-select-item-option', { hasText: text(cell).marketOptionDe }).first().click();
  await page.keyboard.press('Escape');
  await expect(marketSelect(page, cell).locator('.ant-select-selection-item').first()).toContainText('DE');
}

async function clearMarkets(page: Page, cell: Cell): Promise<void> {
  await marketSelect(page, cell).locator('.ant-select-selection-item-remove').first().click();
  await expect(marketSelect(page, cell).locator('.ant-select-selection-item')).toHaveCount(0);
}

function lastCompanyCall(backend: MockBackend) {
  return backend.callsTo('POST', '/onboarding/company').at(-1);
}

function localizedFailure(cell: Cell, status: number): string {
  return cell.lang === 'zh-CN' ? `保存失败 ${status}` : `Save failed ${status}`;
}

async function expectFocusable(locator: Locator): Promise<void> {
  await locator.focus();
  await expect(locator).toBeFocused();
}

/** 保存响应挂起，直到 release()；记录只有一次写请求。 */
function installDelayedSave(backend: MockBackend): { release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  backend.set('POST', '/onboarding/company', async ({ route }) => {
    await gate;
    await route.fulfill({
      body: JSON.stringify({ data: {} }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });
  return { release };
}

function assertNoDownstreamSideEffects(backend: MockBackend): void {
  const paths = backend.calls.map((call) => `${call.method} ${call.path}`);
  for (const forbidden of [
    'POST /icps',
    'POST /discovery-runs',
    'POST /outreach/batches',
    'POST /tasks',
    'POST /campaigns',
    'POST /qgos',
  ]) {
    expect(paths, `不应触发 ${forbidden}`).not.toContain(forbidden);
  }
  const writes = backend.calls.filter((call) => call.method !== 'GET').map((call) => call.path);
  for (const write of writes) {
    expect([
      '/onboarding/company',
      '/onboarding/preview',
      '/auth/login',
      '/auth/register',
      '/auth/logout',
    ]).toContain(write);
  }
  // 保存路径不得触发理解/重试等额外引擎动作。
  expect(paths.some((entry) => /understanding|retry/i.test(entry))).toBe(false);
}

async function captureFinal(
  page: Page,
  cell: Cell,
  backend: MockBackend,
  consoleLog: string[],
  testInfo: import('@playwright/test').TestInfo,
): Promise<void> {
  const name = `${cell.family}-${cell.lang}-${cell.theme}-${cell.width}-final`;
  try {
    await page.screenshot({ fullPage: true, path: testInfo.outputPath(`${name}.png`) });
  } catch {
    // 页面可能已跳转或关闭；附件仍按最终调用账本与 console 留存。
  }
  await testInfo.attach(`${name}-requests.json`, {
    body: JSON.stringify(backend.calls, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach(`${name}-console.txt`, {
    body: consoleLog.join('\n'),
    contentType: 'text/plain',
  });
}

async function capture(
  page: Page,
  cell: Cell,
  backend: MockBackend,
  consoleLog: string[],
  testInfo: import('@playwright/test').TestInfo,
  suffix = '',
): Promise<void> {
  const name = `${cell.family}-${cell.lang}-${cell.theme}-${cell.width}${suffix}`;
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${name} 横向溢出 ${overflow}px`).toBeLessThanOrEqual(1);
  await page.screenshot({ fullPage: true, path: testInfo.outputPath(`${name}.png`) });
  await testInfo.attach(`${name}-requests.json`, {
    body: JSON.stringify(backend.calls, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach(`${name}-console.txt`, {
    body: consoleLog.join('\n'),
    contentType: 'text/plain',
  });
}

async function runFamily(
  family: string,
  page: Page,
  cell: Cell,
  backend: MockBackend,
  consoleLog: string[],
  testInfo: import('@playwright/test').TestInfo,
): Promise<void> {
  const t = text(cell);
  switch (family) {
    case '01-manual-no-market': {
      backend.set('POST', '/onboarding/preview', { started: true, preview: NOT_STARTED_PREVIEW });
      await enterManual(page, cell);
      // name-only 草稿：请求不带官网，不触发理解/重试。
      const previewCalls = backend.callsTo('POST', '/onboarding/preview');
      expect(previewCalls).toHaveLength(1);
      expect((previewCalls[0]!.body as { website?: string }).website).toBeUndefined();
      await addProduct(page, cell, '产品-1');
      await expect(submitButton(page, cell)).toBeEnabled();
      await capture(page, cell, backend, consoleLog, testInfo, '-form-1');
      await submitButton(page, cell).click();
      await page.waitForURL(/\/workspace/);
      expect(backend.callsTo('POST', '/onboarding/preview')).toHaveLength(1);
      const one = lastCompanyCall(backend)!.body as { products?: string[]; targetMarkets?: string[] };
      expect(one.targetMarkets).toEqual([]);
      expect(one.products?.length).toBe(1);
      // 5 个产品同样可保存 []。
      await reenter(page, cell, backend);
      await enterManual(page, cell);
      const secondPreview = backend.callsTo('POST', '/onboarding/preview');
      expect(secondPreview).toHaveLength(2);
      expect((secondPreview[1]!.body as { website?: string }).website).toBeUndefined();
      for (let index = 0; index < 5; index += 1) await addProduct(page, cell, `批量-${index + 1}`);
      await expect(submitButton(page, cell)).toBeEnabled();
      await capture(page, cell, backend, consoleLog, testInfo, '-form-5');
      await submitButton(page, cell).click();
      await page.waitForURL(/\/workspace/);
      expect(backend.callsTo('POST', '/onboarding/preview')).toHaveLength(2);
      const five = lastCompanyCall(backend)!.body as { products?: string[]; targetMarkets?: string[] };
      expect(five.targetMarkets).toEqual([]);
      expect(five.products?.length).toBe(5);
      break;
    }
    case '02-ready-no-market': {
      backend.set('POST', '/onboarding/preview', { started: true, preview: READY_EMPTY_MARKETS });
      await startReadyPreview(page, cell);
      await expect(submitButton(page, cell)).toBeEnabled();
      await capture(page, cell, backend, consoleLog, testInfo, '-form-1');
      await submitButton(page, cell).click();
      await page.waitForURL(/\/workspace/);
      const one = lastCompanyCall(backend)!.body as { products?: string[]; targetMarkets?: string[] };
      expect(one.targetMarkets).toEqual([]);
      expect(one.products?.length).toBe(1);
      // ready 五产品同样可保存 []。
      await reenter(page, cell, backend);
      backend.set('POST', '/onboarding/preview', {
        started: true,
        preview: preview({ markets: [], products: productsFixture(5) }),
      });
      await startReadyPreview(page, cell);
      await expect(submitButton(page, cell)).toBeEnabled();
      await capture(page, cell, backend, consoleLog, testInfo, '-form-5');
      await submitButton(page, cell).click();
      await page.waitForURL(/\/workspace/);
      const five = lastCompanyCall(backend)!.body as { products?: string[]; targetMarkets?: string[] };
      expect(five.targetMarkets).toEqual([]);
      expect(five.products?.length).toBe(5);
      break;
    }
    case '03-ready-suggestion': {
      await startReadyPreview(page, cell);
      await expect(page.getByText(t.suggestedPrefix)).toBeVisible();
      // 预览提示在明暗主题都必须可读（AA 4.5:1），不是只看文字存在。
      // 键盘可达：Tab 到产品“来源”链接时必须出现可见焦点（outline），不能只有 :focus-visible=true。
      let sourceFocused = false;
      for (let step = 0; step < 24; step += 1) {
        await page.keyboard.press('Tab');
        sourceFocused = await page.evaluate(
          () => document.activeElement?.classList?.contains('tag-source') === true,
        );
        if (sourceFocused) break;
      }
      expect(sourceFocused, '来源链接应可通过 Tab 聚焦').toBe(true);
      const focusStyle = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return null;
        const style = getComputedStyle(el);
        return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
      });
      expect(focusStyle?.outlineStyle).not.toBe('none');
      expect(Number.parseFloat(focusStyle?.outlineWidth ?? '0')).toBeGreaterThanOrEqual(2);
      const bannerContrast = await page.evaluate(() => {
        const el = document.querySelector('.preview-banner');
        if (!el) return 0;
        const parse = (value: string): [number, number, number] | null => {
          const rgb = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
          if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
          const srgb = value.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
          if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255];
          return null;
        };
        const style = getComputedStyle(el);
        const fg = parse(style.color);
        const bg = parse(style.backgroundColor);
        if (!fg || !bg) return 0;
        const lin = (c: number) => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        const lum = ([r, g, b]: [number, number, number]) =>
          0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        const l1 = lum(fg);
        const l2 = lum(bg);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      });
      expect(bannerContrast, `preview banner 对比度 ${bannerContrast}`).toBeGreaterThanOrEqual(4.5);
      await expect(marketSelect(page, cell).locator('.ant-select-selection-item')).toHaveCount(0);
      await expect(submitButton(page, cell)).toBeEnabled();
      await capture(page, cell, backend, consoleLog, testInfo, '-suggestion');
      await submitButton(page, cell).click();
      await page.waitForURL(/\/workspace/);
      expect((lastCompanyCall(backend)!.body as { targetMarkets?: string[] }).targetMarkets).toEqual([]);
      break;
    }
    case '04-explicit-and-clear': {
      await startReadyPreview(page, cell);
      // A（ready）显式选择 DE。
      await selectMarketDe(page, cell);
      await capture(page, cell, backend, consoleLog, testInfo, '-selected');
      await submitButton(page, cell).click();
      await page.waitForURL(/\/workspace/);
      expect((lastCompanyCall(backend)!.body as { targetMarkets?: string[] }).targetMarkets).toEqual(['DE']);
      // B（ready）清空 → []。
      await reenter(page, cell, backend);
      await startReadyPreview(page, cell);
      await selectMarketDe(page, cell);
      await clearMarkets(page, cell);
      await capture(page, cell, backend, consoleLog, testInfo, '-cleared');
      await submitButton(page, cell).click();
      await page.waitForURL(/\/workspace/);
      expect((lastCompanyCall(backend)!.body as { targetMarkets?: string[] }).targetMarkets).toEqual([]);
      // C（manual）显式选择 DE。
      await reenter(page, cell, backend);
      backend.set('POST', '/onboarding/preview', { started: true, preview: NOT_STARTED_PREVIEW });
      await enterManual(page, cell);
      await addProduct(page, cell, '手动产品');
      await selectMarketDe(page, cell);
      await capture(page, cell, backend, consoleLog, testInfo, '-manual-selected');
      await submitButton(page, cell).click();
      await page.waitForURL(/\/workspace/);
      expect((lastCompanyCall(backend)!.body as { targetMarkets?: string[] }).targetMarkets).toEqual(['DE']);
      // D（manual）清空 → []。
      await reenter(page, cell, backend);
      await enterManual(page, cell);
      await addProduct(page, cell, '手动产品');
      await selectMarketDe(page, cell);
      await clearMarkets(page, cell);
      await capture(page, cell, backend, consoleLog, testInfo, '-manual-cleared');
      await submitButton(page, cell).click();
      await page.waitForURL(/\/workspace/);
      expect((lastCompanyCall(backend)!.body as { targetMarkets?: string[] }).targetMarkets).toEqual([]);
      break;
    }
    case '05-invalid-inputs': {
      backend.set('POST', '/onboarding/preview', { started: true, preview: NOT_STARTED_PREVIEW });
      await enterManual(page, cell);
      const nameInput = page.locator('label.field').filter({ hasText: t.companyName }).locator('input');
      // 先有 1 个有效产品，确保空/空白名称的禁用不被 0 产品遮蔽。
      await addProduct(page, cell, '有效产品');
      await nameInput.fill('');
      await expect(submitButton(page, cell)).toBeDisabled();
      await nameInput.fill('   ');
      await expect(submitButton(page, cell)).toBeDisabled();
      await nameInput.fill('E2E 测试公司');
      await expect(submitButton(page, cell)).toBeEnabled();
      // 独立测 0 产品：取消唯一产品后不可提交。
      await page.locator('.tag-toggle').first().click();
      await expect(submitButton(page, cell)).toBeDisabled();
      await addProduct(page, cell, '有效产品');
      for (let index = 0; index < 6; index += 1) await addProduct(page, cell, `上限-${index + 1}`);
      await expect(page.getByText(t.productsLimit).first()).toBeVisible();
      await expect(page.locator('.tag-toggle')).toHaveCount(5);
      await expect(submitButton(page, cell)).toBeEnabled();
      await capture(page, cell, backend, consoleLog, testInfo, '-manual-limit');
      // ready 0 产品不可提交。
      await reenter(page, cell, backend);
      backend.set('POST', '/onboarding/preview', {
        started: true,
        preview: preview({ markets: [], products: [] }),
      });
      await startReadyPreview(page, cell);
      await expect(submitButton(page, cell)).toBeDisabled();
      await capture(page, cell, backend, consoleLog, testInfo, '-preview-zero');
      // ready 6 产品：建议最多取 5，不突破原上限。
      await reenter(page, cell, backend);
      backend.set('POST', '/onboarding/preview', {
        started: true,
        preview: preview({ markets: [], products: productsFixture(6) }),
      });
      await startReadyPreview(page, cell);
      await expect(page.locator('.tag-toggle[aria-pressed="true"]')).toHaveCount(5);
      await expect(submitButton(page, cell)).toBeEnabled();
      await capture(page, cell, backend, consoleLog, testInfo, '-preview-six');
      await submitButton(page, cell).click();
      await page.waitForURL(/\/workspace/);
      const six = lastCompanyCall(backend)!.body as { products?: string[] };
      expect(six.products?.length).toBe(5);
      break;
    }
    case '06-understanding-pending': {
      for (const state of ['queued', 'running']) {
        await reenter(page, cell, backend);
        const pending = { started: true, preview: preview({ state, status: 'DRAFT' }) };
        backend.set('POST', '/onboarding/preview', pending);
        backend.set('GET', '/onboarding/preview', pending);
        await page.locator('input[placeholder*="https://"]').fill('https://example.org');
        await page.getByRole('button', { name: t.start }).click();
        await expect(page.getByText(t.waitingTitle)).toBeVisible();
        await expect(submitButton(page, cell)).toHaveCount(0);
        await capture(page, cell, backend, consoleLog, testInfo, `-${state}`);
        // 等待一个轮询周期后仍是同一 pending 态，无完成 POST。
        await page.waitForTimeout(4_300);
        await expect(page.getByText(t.waitingTitle)).toBeVisible();
        expect(backend.callsTo('POST', '/onboarding/company')).toHaveLength(0);
        expect(backend.callsTo('GET', '/onboarding/preview').length).toBeGreaterThan(0);
      }
      break;
    }
    case '07-understanding-failed': {
      backend.set('POST', '/onboarding/preview', {
        started: true,
        preview: preview({ state: 'failed', failure: { stage: 'crawlWebsite' } }),
      });
      await page.locator('input[placeholder*="https://"]').fill('https://example.org');
      await page.getByRole('button', { name: t.start }).click();
      await expect(page.getByRole('heading', { name: t.failureTitle })).toBeVisible();
      await capture(page, cell, backend, consoleLog, testInfo, '-failed');
      const previewCallsBefore = backend.callsTo('POST', '/onboarding/preview').length;
      await page.getByRole('button', { name: t.switchManual }).click();
      await page.waitForTimeout(300);
      expect(backend.callsTo('POST', '/onboarding/preview').length).toBe(previewCallsBefore);
      await addProduct(page, cell, '手动产品');
      await expect(submitButton(page, cell)).toBeEnabled();
      await capture(page, cell, backend, consoleLog, testInfo, '-manual');
      await submitButton(page, cell).click();
      await page.waitForURL(/\/workspace/);
      expect(backend.callsTo('POST', '/onboarding/preview').length).toBe(previewCallsBefore);
      expect((lastCompanyCall(backend)!.body as { targetMarkets?: string[] }).targetMarkets).toEqual([]);
      break;
    }
    case '08-saving-in-flight': {
      await startReadyPreview(page, cell);
      const ready = installDelayedSave(backend);
      const submit = submitButton(page, cell);
      await expectFocusable(submit);
      await page.keyboard.press('Enter');
      await expect(submit).toHaveClass(/ant-btn-loading/);
      // 用户可辨的加载态：加载图标可见，按钮不可再触发。
      await expect(submit.locator('.ant-btn-loading-icon')).toBeVisible();
      await expect(page).not.toHaveURL(/\/workspace/);
      expect(backend.onboardingComplete).toBe(false);
      // 保存中真实重复键盘提交（不 force、不吞异常）：不得产生第二次 POST。
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await expect.poll(() => backend.callsTo('POST', '/onboarding/company').length).toBe(1);
      await capture(page, cell, backend, consoleLog, testInfo, '-saving');
      ready.release();
      await page.waitForURL(/\/workspace/);
      expect(backend.callsTo('POST', '/onboarding/company')).toHaveLength(1);
      // manual 延迟响应同样只发一次。
      await reenter(page, cell, backend);
      backend.set('POST', '/onboarding/preview', { started: true, preview: NOT_STARTED_PREVIEW });
      await enterManual(page, cell);
      await addProduct(page, cell, '手动产品');
      const manual = installDelayedSave(backend);
      const manualSubmit = submitButton(page, cell);
      await expectFocusable(manualSubmit);
      await page.keyboard.press('Enter');
      await expect(manualSubmit).toHaveClass(/ant-btn-loading/);
      await expect(manualSubmit.locator('.ant-btn-loading-icon')).toBeVisible();
      await expect(page).not.toHaveURL(/\/workspace/);
      expect(backend.onboardingComplete).toBe(false);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await expect.poll(() => backend.callsTo('POST', '/onboarding/company').length).toBe(2);
      await capture(page, cell, backend, consoleLog, testInfo, '-manual-saving');
      manual.release();
      await page.waitForURL(/\/workspace/);
      expect(backend.callsTo('POST', '/onboarding/company')).toHaveLength(2);
      break;
    }
    case '09-save-success': {
      await startReadyPreview(page, cell);
      const submit = submitButton(page, cell);
      await expectFocusable(submit);
      await capture(page, cell, backend, consoleLog, testInfo, '-form');
      await page.keyboard.press('Enter'); // 键盘可完成
      await page.waitForURL(/\/workspace/);
      expect(backend.callsTo('POST', '/onboarding/company')).toHaveLength(1);
      expect((lastCompanyCall(backend)!.body as { targetMarkets?: string[] }).targetMarkets).toEqual([]);
      // 成功响应后 mock 完成态为 true；刷新仍完成（非真 DB 证明）。
      expect(backend.onboardingComplete).toBe(true);
      await page.reload();
      await page.waitForTimeout(900);
      await expect(page).toHaveURL(/\/workspace/);
      expect(backend.callsTo('POST', '/onboarding/company')).toHaveLength(1);
      // manual 成功同样完成并可刷新。
      await reenter(page, cell, backend);
      backend.set('POST', '/onboarding/preview', { started: true, preview: NOT_STARTED_PREVIEW });
      await enterManual(page, cell);
      await addProduct(page, cell, '手动产品');
      await capture(page, cell, backend, consoleLog, testInfo, '-manual-form');
      await submitButton(page, cell).click();
      await page.waitForURL(/\/workspace/);
      const manualBody = lastCompanyCall(backend)!.body as { targetMarkets?: string[]; products?: string[] };
      expect(manualBody.targetMarkets).toEqual([]);
      expect(manualBody.products?.length).toBe(1);
      await page.reload();
      await page.waitForTimeout(900);
      await expect(page).toHaveURL(/\/workspace/);
      break;
    }
    case '10-save-failure': {
      const failures = [400, 409, 503];
      let attempt = 0;
      const installFailures = () => {
        attempt = 0;
        backend.set('POST', '/onboarding/company', async ({ route }) => {
          attempt += 1;
          const status = failures[attempt - 1];
          if (status !== undefined) {
            const payload =
              attempt === 1
                ? { error: { code: 'SAVE_FAILED' } } // 无 message → 应用本地化 fallback
                : { error: { code: 'SAVE_FAILED', message: localizedFailure(cell, status) } };
            await route.fulfill({
              body: JSON.stringify(payload),
              contentType: 'application/json',
              status,
            });
            return true;
          }
          await route.fulfill({
            body: JSON.stringify({ data: {} }),
            contentType: 'application/json',
            status: 200,
          });
          return true;
        });
      };
      installFailures();
      await startReadyPreview(page, cell);
      await selectMarketDe(page, cell);
      // 使用修改过的产品：取消默认建议，加入定制产品。
      await page.getByRole('button', { name: /LED 灯具/ }).click();
      await expect(page.getByRole('button', { name: /LED 灯具/ })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      await addProduct(page, cell, '定制产品');
      await expect(page.locator('.tag-toggle[aria-pressed="true"]').first()).toContainText('定制产品');
      const submit = submitButton(page, cell);
      await expectFocusable(submit);
      for (const [index, status] of failures.entries()) {
        if (index === 0) await page.keyboard.press('Enter');
        else await submit.click();
        const error = page.locator('.onboarding-error');
        await expect(error).toBeVisible();
        if (index === 0) await expect(error).toContainText(t.submitFailed);
        else await expect(error).toContainText(localizedFailure(cell, status));
        await expect(page).not.toHaveURL(/\/workspace/);
        expect(backend.onboardingComplete).toBe(false);
        // 逐态核对真实值与请求体：每次失败都没有重试或改值。
        const failedBody = lastCompanyCall(backend)!.body as {
          name?: string;
          products?: string[];
          targetMarkets?: string[];
        };
        expect(failedBody.name).toBe('E2E 测试公司');
        expect(failedBody.products).toEqual(['定制产品']);
        expect(failedBody.targetMarkets).toEqual(['DE']);
        await expect(marketSelect(page, cell).locator('.ant-select-selection-item').first()).toContainText('DE');
        await expect(page.locator('.tag-toggle[aria-pressed="true"]').first()).toContainText('定制产品');
      }
      expect(backend.callsTo('POST', '/onboarding/company')).toHaveLength(3);
      await capture(page, cell, backend, consoleLog, testInfo, '-ready-error');
      await submit.click();
      await page.waitForURL(/\/workspace/);
      const readyBody = lastCompanyCall(backend)!.body as { targetMarkets?: string[] };
      expect(readyBody.targetMarkets).toEqual(['DE']);
      // manual 路径三种失败与逐值保留。
      await reenter(page, cell, backend);
      backend.set('POST', '/onboarding/preview', { started: true, preview: NOT_STARTED_PREVIEW });
      installFailures();
      await enterManual(page, cell);
      const nameInput = page.locator('label.field').filter({ hasText: t.companyName }).locator('input');
      await nameInput.fill('E2E 手动公司');
      await addProduct(page, cell, '手动产品');
      await selectMarketDe(page, cell);
      for (const [index, status] of failures.entries()) {
        await submit.click();
        const error = page.locator('.onboarding-error');
        await expect(error).toBeVisible();
        if (index === 0) await expect(error).toContainText(t.submitFailed);
        else await expect(error).toContainText(localizedFailure(cell, status));
        await expect(page).not.toHaveURL(/\/workspace/);
        expect(backend.onboardingComplete).toBe(false);
        await expect(nameInput).toHaveValue('E2E 手动公司');
        const failedBody = lastCompanyCall(backend)!.body as {
          name?: string;
          products?: string[];
          targetMarkets?: string[];
        };
        expect(failedBody.name).toBe('E2E 手动公司');
        expect(failedBody.products).toEqual(['手动产品']);
        expect(failedBody.targetMarkets).toEqual(['DE']);
        await expect(page.locator('.tag-toggle[aria-pressed="true"]').first()).toContainText('手动产品');
        await expect(marketSelect(page, cell).locator('.ant-select-selection-item').first()).toContainText('DE');
      }
      expect(backend.callsTo('POST', '/onboarding/company')).toHaveLength(7);
      await capture(page, cell, backend, consoleLog, testInfo, '-manual-error');
      await submit.click();
      await page.waitForURL(/\/workspace/);
      const manualBody = lastCompanyCall(backend)!.body as {
        name?: string;
        products?: string[];
        targetMarkets?: string[];
      };
      expect(manualBody.name).toBe('E2E 手动公司');
      expect(manualBody.products).toEqual(['手动产品']);
      expect(manualBody.targetMarkets).toEqual(['DE']);
      break;
    }
    case '11-non-admin': {
      expect(backend.session.workspace.role).toBe('member');
      const forbiddenCopy =
        cell.lang === 'zh-CN' ? '无权限完成建档' : 'You do not have permission to finish setup';
      backend.set('POST', '/onboarding/company', async ({ route }) => {
        await route.fulfill({
          body: JSON.stringify({ error: { code: 'FORBIDDEN', message: forbiddenCopy } }),
          contentType: 'application/json',
          status: 403,
        });
        return true;
      });
      await startReadyPreview(page, cell);
      await submitButton(page, cell).click();
      await expect(page.locator('.onboarding-error')).toContainText(forbiddenCopy);
      await expect(page).not.toHaveURL(/\/workspace/);
      expect(backend.onboardingComplete).toBe(false);
      await capture(page, cell, backend, consoleLog, testInfo, '-forbidden');
      break;
    }
    case '12-loading-entry': {
      backend.set('GET', '/workspace/context', async ({ route, backend: current }) => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        await route.fulfill({
          body: JSON.stringify({
            data: {
              user: current.session.user,
              workspace: { ...current.session.workspaces[0], role: current.session.workspace.role },
              onboarding: { complete: false, companyId: null },
              allowedActions: [],
            },
          }),
          contentType: 'application/json',
          status: 200,
        });
        return true;
      });
      await page.reload();
      await expect(page.getByText(t.loading)).toBeVisible();
      await expect(page.locator('.onboarding-section')).toBeVisible();
      expect(backend.callsTo('POST', '/onboarding/company')).toHaveLength(0);
      // 空名称 + 有效官网：不能开始，也不能进入手动（不发 preview POST）。
      const nameInput = page.locator('.onboarding-section input').first();
      await nameInput.fill('');
      await page.locator('input[placeholder*="https://"]').fill('https://example.org');
      const start = page.getByRole('button', { name: t.start });
      await expect(start).toBeDisabled();
      const manual = page.getByRole('button', { name: t.manual });
      await manual.click(); // 名称守卫拦截：不发 preview，也不离开官网页
      await page.waitForTimeout(200);
      expect(backend.callsTo('POST', '/onboarding/preview')).toHaveLength(0);
      await expect(page.getByRole('button', { name: t.start })).toBeVisible();
      // 有名称但无效官网：开始仍禁用，不虚构国家。
      await nameInput.fill('E2E 测试公司');
      await page.locator('input[placeholder*="https://"]').fill('example.org');
      await expect(start).toBeDisabled();
      await expect(marketSelect(page, cell).locator('.ant-select-selection-item')).toHaveCount(0);
      await capture(page, cell, backend, consoleLog, testInfo, '-invalid-site');
      break;
    }
    default:
      throw new Error(`未知状态族 ${family}`);
  }
  assertNoDownstreamSideEffects(backend);
}

const FAMILIES = [
  '01-manual-no-market',
  '02-ready-no-market',
  '03-ready-suggestion',
  '04-explicit-and-clear',
  '05-invalid-inputs',
  '06-understanding-pending',
  '07-understanding-failed',
  '08-saving-in-flight',
  '09-save-success',
  '10-save-failure',
  '11-non-admin',
  '12-loading-entry',
] as const;

test.describe('B0 未指定市场也可保存：12 族 × 96 格', () => {
  for (const family of FAMILIES) {
    for (const lang of LANGS) {
      for (const theme of THEMES) {
        for (const width of Object.keys(WIDTHS) as Width[]) {
          test(`${family} · ${lang} · ${theme} · ${width}`, async ({ page }, testInfo) => {
            const cell: Cell = { family, lang, theme, width };
            const consoleLog: string[] = [];
            page.on('console', (message) => consoleLog.push(`${message.type()}: ${message.text()}`));
            const pageErrors: string[] = [];
            page.on('pageerror', (error) => pageErrors.push(String(error)));
            const backend = await enterAs(page, cell, family === '11-non-admin' ? { role: 'member' } : {});
            await assertEnvironment(page, cell);
            await capture(page, cell, backend, consoleLog, testInfo, '-entry');
            try {
              await runFamily(family, page, cell, backend, consoleLog, testInfo);
            } finally {
              // 每格结束（含失败）都留存最终完整请求与 console，覆盖最后一次保存 POST。
              await captureFinal(page, cell, backend, consoleLog, testInfo);
            }
            expect(pageErrors, '页面不得抛出未捕获异常').toEqual([]);
          });
        }
      }
    }
  }
});

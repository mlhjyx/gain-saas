/**
 * B0：未指定市场也可保存资料——真实浏览器全组合矩阵。
 *
 * 12 个状态族 × 2 应用语言（zh-CN/en-US）× 2 实际主题（light/dark）×
 * 2 实际尺寸（1440×900 / 390×844）= 96 格，不抽样；每格跑该族全部子场景。
 * 语言与主题沿应用自身偏好持久化切换（登录页 AuthTools → updatePreferences），
 * 不靠浏览器 locale/colorScheme 假设；onboarding 页无顶栏按钮也不影响。
 */
import { expect, test, type Page } from '@playwright/test';

import { installMockBackend, type MockBackend } from './support/mock-backend';

test.use({ trace: 'retain-on-failure' });

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

type Cell = { family: string; lang: Lang; theme: Theme; width: Width };

function text(page: Page | null, cell: Cell) {
  return TEXT[cell.lang];
}

async function enterAs(page: Page, cell: Cell): Promise<MockBackend> {
  await page.setViewportSize(WIDTHS[cell.width]);
  const backend = await installMockBackend(page, { onboardingComplete: false });
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
  await expect(page.getByRole('heading', { name: text(null, cell).title })).toBeVisible();
  return backend;
}

/** 保存成功会跳 /workspace；同格再验下一子场景时重置 mock 完成态并回到向导。 */
async function reenter(page: Page, cell: Cell, backend: MockBackend): Promise<void> {
  backend.onboardingComplete = false;
  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { name: text(null, cell).title })).toBeVisible();
}

async function assertEnvironment(page: Page, cell: Cell): Promise<void> {
  const t = text(null, cell);
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
  expect(match, `body 背景应为计算色：${bg}`).toBeTruthy();
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
  return page.getByRole('button', { name: text(null, cell).submit });
}

function marketSelect(page: Page, cell: Cell) {
  return page
    .locator('.field')
    .filter({ hasText: text(null, cell).marketsLabel })
    .locator('.ant-select');
}

async function fillNameOnStart(page: Page, name: string): Promise<void> {
  await page.locator('.onboarding-section input').first().fill(name);
}

async function enterManual(page: Page, cell: Cell): Promise<void> {
  await fillNameOnStart(page, 'E2E 测试公司');
  await page.getByRole('button', { name: text(null, cell).manual }).click();
  await expect(submitButton(page, cell)).toBeVisible();
}

async function startReadyPreview(page: Page, cell: Cell): Promise<void> {
  await page.locator('input[placeholder*="https://"]').fill('https://example.org');
  await page.getByRole('button', { name: text(null, cell).start }).click();
  await expect(submitButton(page, cell)).toBeVisible();
}

async function addProduct(page: Page, cell: Cell, name: string): Promise<void> {
  const input = page.getByPlaceholder(text(null, cell).productPlaceholder);
  await input.fill(name);
  await input.press('Enter');
}

function lastCompanyCall(backend: MockBackend) {
  return backend.callsTo('POST', '/onboarding/company').at(-1);
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
  // 导航类 GET 不算副作用；写请求只允许 onboarding 自身。
  const writes = backend.calls
    .filter((call) => call.method !== 'GET')
    .map((call) => call.path);
  for (const write of writes) {
    expect(['/onboarding/company', '/onboarding/preview', '/auth/login', '/auth/register', '/auth/logout']).toContain(write);
  }
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
  const t = text(null, cell);
  switch (family) {
    case '01-manual-no-market': {
      backend.set('POST', '/onboarding/preview', { started: true, preview: NOT_STARTED_PREVIEW });
      await enterManual(page, cell);
      // 子场景 A：名称草稿 + 1 个产品，不指定市场直接保存。
      await addProduct(page, cell, '产品-1');
      await expect(submitButton(page, cell)).toBeEnabled();
      await capture(page, cell, backend, consoleLog, testInfo, '-form-1');
      await submitButton(page, cell).click();
      await page.waitForURL(/\/workspace/);
      const one = lastCompanyCall(backend)!.body as { products?: string[]; targetMarkets?: string[] };
      expect(one.targetMarkets).toEqual([]);
      expect(one.products?.length).toBe(1);
      // 子场景 B：5 个产品同样可保存 []。
      await reenter(page, cell, backend);
      await enterManual(page, cell);
      for (let index = 0; index < 5; index += 1) await addProduct(page, cell, `批量-${index + 1}`);
      await expect(submitButton(page, cell)).toBeEnabled();
      await capture(page, cell, backend, consoleLog, testInfo, '-form-5');
      await submitButton(page, cell).click();
      await page.waitForURL(/\/workspace/);
      const five = lastCompanyCall(backend)!.body as { products?: string[]; targetMarkets?: string[] };
      expect(five.targetMarkets).toEqual([]);
      expect(five.products?.length).toBe(5);
      break;
    }
    case '02-ready-no-market': {
      backend.set('POST', '/onboarding/preview', { started: true, preview: READY_EMPTY_MARKETS });
      await startReadyPreview(page, cell);
      await expect(submitButton(page, cell)).toBeEnabled();
      await capture(page, cell, backend, consoleLog, testInfo, '-form');
      await submitButton(page, cell).click();
      await page.waitForURL(/\/workspace/);
      expect((lastCompanyCall(backend)!.body as { targetMarkets?: string[] }).targetMarkets).toEqual([]);
      break;
    }
    case '03-ready-suggestion': {
      await startReadyPreview(page, cell);
      await expect(page.getByText(t.suggestedPrefix)).toBeVisible();
      // 建议只能展示，不能自动勾选、不能冒充用户确认。
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
      // 子场景 A：显式选择 DE 原样透传。
      await marketSelect(page, cell).click();
      await page.locator('.ant-select-item-option', { hasText: t.marketOptionDe }).first().click();
      await page.keyboard.press('Escape');
      await expect(marketSelect(page, cell).locator('.ant-select-selection-item').first()).toContainText('DE');
      await capture(page, cell, backend, consoleLog, testInfo, '-selected');
      await submitButton(page, cell).click();
      await page.waitForURL(/\/workspace/);
      expect((lastCompanyCall(backend)!.body as { targetMarkets?: string[] }).targetMarkets).toEqual(['DE']);
      // 子场景 B：清空后仍保存 []，不补回建议国家。
      await reenter(page, cell, backend);
      await startReadyPreview(page, cell);
      await marketSelect(page, cell).click();
      await page.locator('.ant-select-item-option', { hasText: t.marketOptionDe }).first().click();
      await page.keyboard.press('Escape');
      await marketSelect(page, cell).locator('.ant-select-selection-item-remove').first().click();
      await expect(marketSelect(page, cell).locator('.ant-select-selection-item')).toHaveCount(0);
      await capture(page, cell, backend, consoleLog, testInfo, '-cleared');
      await submitButton(page, cell).click();
      await page.waitForURL(/\/workspace/);
      expect((lastCompanyCall(backend)!.body as { targetMarkets?: string[] }).targetMarkets).toEqual([]);
      break;
    }
    case '05-invalid-inputs': {
      backend.set('POST', '/onboarding/preview', { started: true, preview: NOT_STARTED_PREVIEW });
      await enterManual(page, cell);
      const nameInput = page
        .locator('label.field')
        .filter({ hasText: t.companyName })
        .locator('input');
      await nameInput.fill('   ');
      await expect(submitButton(page, cell)).toBeDisabled();
      await nameInput.fill('E2E 测试公司');
      await expect(submitButton(page, cell)).toBeDisabled(); // 0 产品不可提交
      for (let index = 0; index < 6; index += 1) await addProduct(page, cell, `上限-${index + 1}`);
      await expect(page.getByText(t.productsLimit)).toBeVisible();
      await expect(page.locator('.tag-toggle')).toHaveCount(5);
      await expect(submitButton(page, cell)).toBeEnabled();
      await capture(page, cell, backend, consoleLog, testInfo, '-invalid');
      break;
    }
    case '06-understanding-pending': {
      for (const state of ['queued', 'running']) {
        await reenter(page, cell, backend);
        backend.set('POST', '/onboarding/preview', {
          started: true,
          preview: preview({ state, status: 'DRAFT' }),
        });
        await page.locator('input[placeholder*="https://"]').fill('https://example.org');
        await page.getByRole('button', { name: t.start }).click();
        await expect(page.getByText(t.waitingTitle)).toBeVisible();
        await capture(page, cell, backend, consoleLog, testInfo, `-${state}`);
        expect(backend.callsTo('POST', '/onboarding/company')).toHaveLength(0);
      }
      break;
    }
    case '07-understanding-failed': {
      backend.set(
        'POST',
        '/onboarding/preview',
        { started: true, preview: preview({ state: 'failed', failure: { stage: 'crawlWebsite' } }) },
      );
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
      await submitButton(page, cell).click();
      await page.waitForURL(/\/workspace/);
      expect((lastCompanyCall(backend)!.body as { targetMarkets?: string[] }).targetMarkets).toEqual([]);
      break;
    }
    case '08-saving-in-flight': {
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
      await startReadyPreview(page, cell);
      const submit = submitButton(page, cell);
      await submit.click();
      await submit.click({ force: true }).catch(() => {});
      await expect(submit).toHaveClass(/ant-btn-loading/);
      expect(backend.callsTo('POST', '/onboarding/company')).toHaveLength(1);
      await capture(page, cell, backend, consoleLog, testInfo, '-saving');
      release();
      await page.waitForURL(/\/workspace/);
      expect(backend.callsTo('POST', '/onboarding/company')).toHaveLength(1);
      break;
    }
    case '09-save-success': {
      await startReadyPreview(page, cell);
      await capture(page, cell, backend, consoleLog, testInfo, '-form');
      await submitButton(page, cell).click();
      await page.waitForURL(/\/workspace/);
      expect(backend.callsTo('POST', '/onboarding/company')).toHaveLength(1);
      expect((lastCompanyCall(backend)!.body as { targetMarkets?: string[] }).targetMarkets).toEqual([]);
      break;
    }
    case '10-save-failure': {
      const failures = [400, 409, 503];
      let attempt = 0;
      backend.set('POST', '/onboarding/company', async ({ route }) => {
        attempt += 1;
        const status = failures[attempt - 1];
        if (status !== undefined) {
          await route.fulfill({
            body: JSON.stringify({ error: { code: 'SAVE_FAILED', message: `保存失败 ${status}` } }),
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
      await startReadyPreview(page, cell);
      const submit = submitButton(page, cell);
      for (const status of failures) {
        await submit.click();
        await expect(page.locator('.onboarding-error')).toContainText(String(status));
        await expect(page).not.toHaveURL(/\/workspace/);
        if (status === 400) await capture(page, cell, backend, consoleLog, testInfo, '-error');
      }
      expect(backend.callsTo('POST', '/onboarding/company')).toHaveLength(3);
      // 输入与选择保留；显式重试可成功，不自动重试。
      await expect(marketSelect(page, cell)).toBeVisible();
      await submit.click();
      await page.waitForURL(/\/workspace/);
      expect(backend.callsTo('POST', '/onboarding/company')).toHaveLength(4);
      break;
    }
    case '11-non-admin': {
      backend.set('POST', '/onboarding/company', async ({ route }) => {
        await route.fulfill({
          body: JSON.stringify({ error: { code: 'FORBIDDEN', message: '无权限完成建档' } }),
          contentType: 'application/json',
          status: 403,
        });
        return true;
      });
      await startReadyPreview(page, cell);
      await submitButton(page, cell).click();
      await expect(page.locator('.onboarding-error')).toBeVisible();
      await expect(page).not.toHaveURL(/\/workspace/);
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
      await fillNameOnStart(page, 'E2E 测试公司');
      await page.locator('input[placeholder*="https://"]').fill('example.org');
      const start = page.getByRole('button', { name: t.start });
      await expect(start).toBeDisabled();
      await start.click({ force: true }).catch(() => {});
      await page.waitForTimeout(200);
      expect(backend.callsTo('POST', '/onboarding/preview')).toHaveLength(0);
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
            const backend = await enterAs(page, cell);
            await assertEnvironment(page, cell);
            await capture(page, cell, backend, consoleLog, testInfo, '-entry');
            await runFamily(family, page, cell, backend, consoleLog, testInfo);
            expect(pageErrors, '页面不得抛出未捕获异常').toEqual([]);
          });
        }
      }
    }
  }
});

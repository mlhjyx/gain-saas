import { writeFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const NOW = '2026-11-08T10:12:30.000Z';
const ICP = {
  id: 'icp-1',
  name: '德国五金进口商',
  status: 'ACTIVE',
  companyId: 'c1',
  createdAt: NOW,
  updatedAt: NOW,
  personas: [],
  rules: [],
  targetMarkets: ['DE'],
  version: 1,
};
const LEAD = {
  canonicalCompanyId: 'c1',
  company: { country: 'DE', domain: 'muster-metallbau.de', name: 'Muster Metallbau GmbH' },
  createdAt: NOW,
  fitVerdict: 'match',
  icpId: 'icp-1',
  id: 'lead-1',
  queue: 'needs_review',
  scored: true,
  status: 'DISCOVERED',
  totalScore: 82,
  updatedAt: NOW,
};


type ColorClass = 'brand' | 'error' | 'neutral' | 'success' | 'unknown' | 'warning';

function rgbClass(r: number, g: number, b: number): ColorClass {
  if (Math.max(r, g, b) - Math.min(r, g, b) <= 3) return 'neutral';
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2 / 255;
  let h = 0;
  if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  const s = d / 255 / (1 - Math.abs(2 * l - 1) || 1);
  if (b > r && b > g && h >= 200 && h <= 250 && s > 0.15) return 'brand';
  if (g > r && g > b && h >= 100 && h <= 180) return 'success';
  if (r > g && r > b && h >= 10 && h <= 50) return 'warning';
  if (r > g && r > b && (h >= 340 || h <= 10)) return 'error';
  return 'unknown';
}

function classify(value: string): ColorClass {
  const v = value.trim().toLowerCase();
  if (!v || v === 'none' || v === 'transparent' || v === 'currentcolor') return 'neutral';
  if (v === 'white' || v === 'black') return 'neutral';
  const oklab = v.match(/^oklab\(([\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s*\/\s*([\d.]+))?\)/);
  if (oklab) {
    if (Number(oklab[4] ?? 1) === 0) return 'neutral';
    if (Math.abs(Number(oklab[2])) < 0.01 && Math.abs(Number(oklab[3])) < 0.01) return 'neutral';
    return 'unknown';
  }
  const srgb = v.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/);
  if (srgb) {
    if (Number(srgb[4] ?? 1) === 0) return 'neutral';
    return rgbClass(Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255);
  }
  const rgb = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/);
  if (rgb) {
    if (Number(rgb[4] ?? 1) === 0) return 'neutral';
    return rgbClass(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  }
  return 'unknown';
}

const PAGES = [
  '/workspace',
  '/leads',
  '/companies',
  '/find-buyers',
  '/campaigns',
  '/qgos',
  '/tasks',
  '/notifications',
  '/growth?tab=reviews',
  '/growth?tab=metrics',
  '/settings/members',
  '/settings/suppressions',
  '/settings/sources',
  '/settings/privacy',
  '/settings/audit',
];

function collectColors() {
  const props = [
    'color',
    // getComputedStyle().getPropertyValue() 只认短横线属性名：此前写成驼峰
    // （backgroundColor 等）会一律返回空串，背景色与边框色从未被采样。
    'background-color',
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
    'outline-color',
    'fill',
    'stroke',
    'text-decoration-color',
  ];
  const rows: Array<{ prop: string; value: string; tag: string; cls: string }> = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    for (const prop of props) {
      // 没画出来的描边不采样：outline-style:none 时浏览器仍会报一个 oklab 的默认 outline-color。
      if (prop === 'outline-color' && style.outlineStyle === 'none') continue;
      const value = style.getPropertyValue(prop);
      if (!value || value === 'none' || value === 'transparent') continue;
      rows.push({
        cls: String((el as HTMLElement).className ?? '').slice(0, 120),
        prop,
        tag: el.tagName.toLowerCase(),
        value,
      });
    }
    if (style.boxShadow && style.boxShadow !== 'none') {
      for (const match of style.boxShadow.matchAll(/(?:rgba?|color)\([^)]*\)/g)) {
        rows.push({
          cls: String((el as HTMLElement).className ?? '').slice(0, 120),
          prop: 'boxShadow',
          tag: el.tagName.toLowerCase(),
          value: match[0],
        });
      }
    }
  }
  return rows;
}

test('pass2 color scan + evidence screenshots', async ({ page }) => {
  test.setTimeout(300_000);
  const backend = await installMockBackend(page);
  backend.set('GET', '/icps', [ICP]);
  backend.set('GET', '/leads', [LEAD]);
  backend.set('GET', '/icps/icp-1/lead-queues', {
    needs_review: 1,
    recommended: 0,
    rejected: 0,
    sanctions_hold: 0,
    scored: true,
    suppressed: 0,
  });
  backend.set('GET', '/audit', { entries: [], nextCursor: null, total: 0 });
  backend.set('GET', '/notifications', {
    items: [
      {
        createdAt: NOW,
        id: 'n1',
        link: '/leads',
        refId: 'lead-1',
        title: '新的买家线索',
        type: 'LeadQualified',
      },
    ],
    unreadCount: 1,
  });

  await loginAs(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(500);

  const all: Array<{ page: string; theme: string; prop: string; value: string; tag: string; cls: string }> = [];

  for (const theme of ['light', 'dark'] as const) {
    if (theme === 'dark') {
      await page.locator("[data-gs='account-trigger']").click();
      await page.locator("[data-gs='theme-toggle']").click();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
    }
    for (const path of PAGES) {
      await page.goto(path);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(350);
      const rows = await page.evaluate(collectColors);
      for (const row of rows) all.push({ ...row, page: path, theme });
      if (['/workspace', '/leads', '/settings/members'].includes(path)) {
        const name = path.replace(/[/?=&]/g, '_').replace(/^_/, '');
        await page.screenshot({
          fullPage: true,
          path: `docs/evidence/ui-restyle/pass2/after-${name}-${theme}.png`,
        });
      }
    }
  }

  const counts = new Map<string, number>();
  for (const row of all) {
    const key = `${row.theme} | ${row.value}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const unique = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const violations = all.filter((row) => classify(row.value) === 'unknown');
  const classes = new Map<string, number>();
  for (const row of all) {
    const c = classify(row.value);
    classes.set(c, (classes.get(c) ?? 0) + 1);
  }
  const report = {
    generatedAt: new Date().toISOString(),
    pages: PAGES,
    themes: ['light', 'dark'],
    totalSamples: all.length,
    classCounts: Object.fromEntries([...classes.entries()].sort()),
    unique: unique.map(([key, count]) => {
      const value = key.split(' | ')[1]!;
      return { count, key, class: classify(value) };
    }),
    violations,
  };
  writeFileSync(
    'docs/evidence/ui-restyle/pass2/color-scan.json',
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const lines = [
    '# pass2 rendered DOM color scan',
    `generatedAt: ${report.generatedAt}`,
    `pages: ${PAGES.join(', ')}`,
    `totalSamples: ${all.length}`,
    `classCounts: ${JSON.stringify(report.classCounts)}`,
    '',
    '## unique colors',
    ...unique.map(([key, count]) => {
      const value = key.split(' | ')[1]!;
      return `${count}\t${key}\t${classify(value)}`;
    }),
    '',
    `## violations (${violations.length})`,
    ...violations.map(
      (row) =>
        `${row.theme}\t${row.page}\t${row.tag}.${row.cls}\t${row.prop}=${row.value}`,
    ),
  ];
  writeFileSync(
    'docs/evidence/ui-restyle/pass2/color-scan.txt',
    `${lines.join('\n')}\n`,
  );
  console.log('PASS2_COLOR_UNIQUE_START');
  for (const [key, count] of unique) {
    const value = key.split(' | ')[1]!;
    console.log(`${count}\t${key}\t${classify(value)}`);
  }
  console.log('PASS2_COLOR_UNIQUE_END');
  expect(violations, JSON.stringify(violations.slice(0, 20), null, 2)).toEqual([]);
});

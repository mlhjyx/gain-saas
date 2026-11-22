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

test('pass2 measurable specs', async ({ page }) => {
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
  await loginAs(page);
  await page.goto('/workspace');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(500);

  const workspace = await page.evaluate(() => {
    const style = (el: Element | null) => (el ? getComputedStyle(el) : null);
    const rect = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
    const groupLabels = [...document.querySelectorAll('.vben-sub-menu-content')];
    const items = [...document.querySelectorAll('.vben-menu-item')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const groupTitle = document.querySelector('.vben-sub-menu-content__title');
    const active = document.querySelector('.vben-menu-item.is-active');
    const card = document.querySelector('.wk__summary');
    const cta = document.querySelector('.wk__cta');
    return {
      groupLabel: {
        count: groupLabels.length,
        fontSize: style(groupLabels[0] ?? null)?.fontSize,
        height: rect(groupLabels[0] ?? null)?.height,
        titleFontSize: style(groupTitle ?? null)?.fontSize,
        html: groupLabels[0]?.outerHTML.slice(0, 600),
      },
      items: {
        count: items.length,
        fontSize: style(items[0] ?? null)?.fontSize,
        fontWeight: style(items[0] ?? null)?.fontWeight,
        heights: [...new Set(items.map((el) => Math.round(el.getBoundingClientRect().height)))],
      },
      active: active
        ? {
            background: style(active)?.backgroundColor,
            color: style(active)?.color,
            indicatorWidth: getComputedStyle(active, '::before').width,
          }
        : null,
      card: card
        ? {
            border: `${style(card)?.borderTopWidth} ${style(card)?.borderTopStyle} ${style(card)?.borderTopColor}`,
            radius: style(card)?.borderRadius,
            shadow: style(card)?.boxShadow,
          }
        : null,
      mainCtaRadius: style(cta ?? null)?.borderRadius,
    };
  });

  await page.goto('/leads');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(500);
  const leads = await page.evaluate(() => {
    const style = (el: Element | null) => (el ? getComputedStyle(el) : null);
    const accept = document.querySelector('.ld__actions .ld__action--accept');
    const card = document.querySelector('.ld__lead');
    return {
      queueCards: document.querySelectorAll('.ld__queues').length,
      toolbar: document.querySelectorAll('.ld__toolbar').length,
      search: document.querySelectorAll('.ld__toolbar input[type="search"]').length,
      acceptRadius: style(accept ?? null)?.borderRadius,
      cardRadius: style(card ?? null)?.borderRadius,
      cardShadow: style(card ?? null)?.boxShadow,
    };
  });

  const report = { generatedAt: new Date().toISOString(), leads, workspace };
  writeFileSync(
    'docs/evidence/ui-restyle/pass2/measurements.json',
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log('PASS2_MEASUREMENTS', JSON.stringify(report));

  expect(workspace.groupLabel.height).toBeGreaterThanOrEqual(35);
  expect(workspace.items.fontWeight).toBe('500');
  expect(workspace.items.heights).toContain(32);
  expect(workspace.groupLabel.titleFontSize).toBe('11px');
  expect(workspace.active?.indicatorWidth).toBe('3px');
  expect(workspace.mainCtaRadius).toBe('9999px');
  expect(workspace.card?.radius).toBe('10px');
  expect(workspace.card?.shadow).not.toBe('none');
  expect(leads.queueCards).toBe(0);
  expect(leads.toolbar).toBe(1);
  expect(leads.search).toBe(1);
  expect(leads.acceptRadius).toBe('9999px');
});

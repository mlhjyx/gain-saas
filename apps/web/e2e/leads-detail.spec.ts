/**
 * P5b-08：线索详情整页（深链 + 四 tab + 裁决动作）。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const NOW = '2026-11-08T10:12:30.000Z';

const PACKAGE = {
  lead_id: 'lead-1',
  status: 'DISCOVERED',
  company: {
    canonical_company_id: 'c1',
    name: 'Muster Metallbau GmbH',
    domain: 'muster-metallbau.de',
    country: 'DE',
    city: 'Dortmund',
  },
  company_profile: { trade_role: 'importer', industry: 'metalworking' },
  identifiers: { vat_id: 'DE123456789' },
  contact_points: [{ kind: 'website', url: 'https://muster-metallbau.de/kontakt', status: 'company_level' }],
  evidence: [{ type: 'website_profile', url: 'https://muster-metallbau.de', support: '官网显示进口业务' }],
  fit: { verdict: 'match' },
  sanctions: { status: 'clear', screened_at: NOW },
  valid_until: NOW,
};

test('线索详情深链、四 tab 与接受动作', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/leads/lead-1/package', PACKAGE);
  backend.set('GET', '/leads/lead-1/outreach-drafts', { data: null });
  backend.set('POST', '/leads/lead-1/accept', { accepted: true, eventId: 'evt-1' });

  await loginAs(page);
  await page.goto('/leads/lead-1');

  await expect(
    page.getByRole('heading', { level: 1, name: 'Muster Metallbau GmbH' }),
  ).toBeVisible();
  await expect(page.getByRole('tab')).toHaveText(['档案', '决策人', '触达草稿', '结果']);

  // tab 进 URL，可直接分享
  await page.getByRole('tab', { name: '结果' }).click();
  await page.waitForURL((url) => url.pathname === '/leads/lead-1' && url.searchParams.get('tab') === 'outcomes');
  // 页面切换有 120–180ms 淡入过渡；等过渡结束再点操作条，避免旧/新视图同时在 DOM。
  await page.waitForTimeout(600);

  // 接受动作：确认后 POST 到 accept
  await page.getByRole('button', { name: '值得跟进' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '确认跟进' }).click();
  await expect.poll(() => backend.callsTo('POST', '/leads/lead-1/accept').length).toBe(1);
});

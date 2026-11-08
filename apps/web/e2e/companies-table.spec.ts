/**
 * P5b-09：公司档案表格化——搜索、状态筛选、行内单一主按钮与「更多」菜单。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const NOW = '2026-11-08T10:12:30.000Z';

const COMPANIES = [
  {
    id: 'c1',
    name: 'Muster Metallbau GmbH',
    domain: 'muster-metallbau.de',
    status: 'REVIEW',
    industry: 'metalworking',
    created_at: NOW,
  },
  {
    id: 'c2',
    name: 'Nordlicht Handel AG',
    domain: 'nordlicht-handel.de',
    status: 'DRAFT',
    industry: 'wholesale',
    created_at: NOW,
  },
];

test('公司档案表格：搜索与状态筛选、行内动作', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/companies', COMPANIES);

  await loginAs(page);
  await page.goto('/companies');

  const rows = page.locator('.cp__table tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole('button', { name: '查看档案' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '补全资料' })).toHaveCount(1);

  // 搜索：按名称/域名过滤，计数与列表同源
  await page.getByPlaceholder('搜索公司名称、域名或行业').fill('nordlicht');
  await expect(rows).toHaveCount(1);
  await expect(page.getByText('显示 1 / 2 家')).toBeVisible();

  // 状态筛选：草稿只剩 DRAFT 那家
  await page.getByPlaceholder('搜索公司名称、域名或行业').fill('');
  await page.locator('.cp__status-filter').selectOption('DRAFT');
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole('button', { name: '补全资料' })).toHaveCount(1);

  // 行内「更多」菜单可展开
  await page.locator('.cp__more summary').first().click();
  await expect(page.locator('.cp__menu').first()).toBeVisible();
});

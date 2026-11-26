import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

function testOrigin(baseURL?: string): string {
  return new URL(baseURL ?? 'http://127.0.0.1:4173').origin;
}

test('dark mode semantic tokens reach WCAG AA and GS_BRAND unifies light bgLayout', async ({
  page,
}, testInfo) => {
  const appVueSource = readFileSync(
    resolve(process.cwd(), 'apps/web/src/app.vue'),
    'utf8',
  );
  expect(appVueSource).toMatch(/export\s+const\s+GS_BRAND\s*=/);
  expect(appVueSource).toMatch(/light:\s*\{[\s\S]*?bgLayout:\s*['"]#F7F8FB['"]/);

  const zhP0 = JSON.parse(
    readFileSync(resolve(process.cwd(), 'apps/web/src/locales/langs/zh-CN/gainosP0.json'), 'utf8'),
  ) as Record<string, unknown>;
  const enP0 = JSON.parse(
    readFileSync(resolve(process.cwd(), 'apps/web/src/locales/langs/en-US/gainosP0.json'), 'utf8'),
  ) as Record<string, unknown>;
  const flattenKeys = (obj: Record<string, unknown>, prefix = ''): string[] =>
    Object.entries(obj)
      .flatMap(([k, v]) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? flattenKeys(v as Record<string, unknown>, prefix ? `${prefix}.${k}` : k)
          : [prefix ? `${prefix}.${k}` : k],
      )
      .sort();
  expect(flattenKeys(zhP0)).toEqual(flattenKeys(enP0));

  const backend = await installMockBackend(page, {
    origin: testOrigin(testInfo.project.use.baseURL),
  });
  backend.set('GET', '/suppressions', {
    data: [
      {
        id: 'sup-1',
        type: 'email',
        value: 'blocked@example.com',
        reason: 'manual',
        protectionClass: 'PREFERENCE',
        createdAt: '2026-11-20T08:00:00.000Z',
      },
    ],
    page: { has_more: true, next_cursor: 'cursor-1' },
  });

  await loginAs(page);
  await page.getByRole('button', { name: 'dark' }).click();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);

  await page.goto('/settings/suppressions');
  await expect(page.getByText('blocked@example.com')).toBeVisible();

  // Trigger an inline AntDV error Alert by submitting an empty suppression entry.
  await page.getByRole('button', { name: '加入' }).click();
  const errorAlert = page.locator('.ant-alert-error').first();
  await expect(errorAlert).toBeVisible();

  const errorIconColor = await errorAlert
    .locator('.ant-alert-icon')
    .evaluate((el) => getComputedStyle(el).color);
  expect(errorIconColor).toBe('rgb(248, 113, 113)');

  const dangerLinkColor = await page
    .locator('.ant-btn-link.ant-btn-dangerous')
    .first()
    .evaluate((el) => getComputedStyle(el).color);
  expect(dangerLinkColor).toBe('rgb(248, 113, 113)');

  const primaryLinkColor = await page
    .locator('.ant-btn-link:not(.ant-btn-dangerous)')
    .first()
    .evaluate((el) => getComputedStyle(el).color);
  expect(primaryLinkColor).toBe('rgb(107, 142, 255)');

  const axe = await new AxeBuilder({ page })
    .include('main')
    .withRules(['color-contrast'])
    .analyze();
  expect(axe.violations, JSON.stringify(axe.violations, null, 2)).toEqual([]);
});

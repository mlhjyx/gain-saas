/**
 * P5b-19：韧性用例——双击只提交一次、断网显示可重试错误、恢复后可重试成功。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const ICP = {
  id: 'icp-1',
  name: '德国五金进口商',
  status: 'ACTIVE',
  createdAt: '2026-11-08T10:00:00.000Z',
  updatedAt: '2026-11-08T10:00:00.000Z',
};

const LEAD = {
  canonicalCompanyId: 'c1',
  company: { country: 'DE', domain: 'muster-metallbau.de', name: 'Muster Metallbau GmbH' },
  createdAt: '2026-11-08T10:12:30.000Z',
  fitVerdict: 'match',
  icpId: 'icp-1',
  id: 'lead-1',
  queue: 'needs_review',
  scored: true,
  status: 'DISCOVERED',
  totalScore: 82,
  updatedAt: '2026-11-08T10:12:30.000Z',
};

test('双击「确认跟进」只提交一次', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/icps', [ICP]);
  backend.set('GET', '/leads', [LEAD]);
  backend.set(
    'POST',
    '/leads/lead-1/accept',
    async ({ route }) => {
      // 慢响应：模拟用户在网络未返回前重复点击。
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.fulfill({
        body: JSON.stringify({ accepted: true, eventId: 'evt-1' }),
        contentType: 'application/json',
        status: 200,
      });
      return true;
    },
  );

  await loginAs(page);
  await page.goto('/leads');
  // 队列筛选按钮也叫「值得跟进」，必须限定在线索卡片内。
  await page
    .locator('.ld__lead')
    .filter({ hasText: 'Muster Metallbau GmbH' })
    .getByRole('button', { name: '值得跟进' })
    .click();
  const dialog = page.getByRole('dialog');
  const confirm = dialog.getByRole('button', { name: '确认跟进' });
  // 真实双击：两次 click 在请求返回前连续发生，第二次应落在禁用态而不产生新请求。
  await confirm.dblclick();
  await expect.poll(() => backend.callsTo('POST', '/leads/lead-1/accept').length, {
    timeout: 5000,
  }).toBe(1);
});

test('断网时显示可重试错误，恢复后重试成功', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/icps', [ICP]);
  let offline = true;
  backend.set('GET', '/leads', async ({ route }) => {
    if (offline) {
      await route.abort('failed');
      return true;
    }
    await route.fulfill({
      body: JSON.stringify([LEAD]),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });

  await loginAs(page);
  await page.goto('/leads');

  // 引擎/网络不可用：错误态给出「发生了什么」与重试按钮，而不是空列表。
  await expect(page.getByRole('alert').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '重试' }).first()).toBeVisible();

  offline = false;
  await page.getByRole('button', { name: '重试' }).first().click();
  await expect(page.getByText('Muster Metallbau GmbH')).toBeVisible();
});

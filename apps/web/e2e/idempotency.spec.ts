/**
 * P5b-05：Idempotency-Key 透传与重试复用。
 *
 * 场景：用户点「确认跟进」→ 网络失败（请求已出但响应丢失，服务端可能已执行）→
 * 用户再点一次。前端必须在两次尝试里发送**同一个** Idempotency-Key，
 * 服务端才能按幂等重放而不是重复执行副作用。
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

test('接受动作失败后重试沿用同一 Idempotency-Key', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/icps', [ICP]);
  backend.set('GET', '/leads', [LEAD]);
  let attempts = 0;
  backend.set('POST', '/leads/lead-1/accept', async ({ route }) => {
    attempts += 1;
    if (attempts === 1) {
      await route.abort('failed'); // 第一次：请求发出但响应丢失
      return true;
    }
    await route.fulfill({
      body: JSON.stringify({ accepted: true, eventId: 'evt-1' }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });

  await loginAs(page);
  await page.goto('/leads');
  await page
    .locator('.ld__lead')
    .filter({ hasText: 'Muster Metallbau GmbH' })
    .getByRole('button', { name: '值得跟进' })
    .click();
  const dialog = page.getByRole('dialog');
  const confirm = dialog.getByRole('button', { name: '确认跟进' });

  await confirm.click();
  // 第一次失败：错误提示出现，按钮恢复可点。
  await expect(dialog.getByRole('alert').first()).toBeVisible();
  await expect(confirm).toBeEnabled();

  await confirm.click();
  await expect.poll(() => backend.callsTo('POST', '/leads/lead-1/accept').length, {
    timeout: 5000,
  }).toBe(2);

  const [first, second] = backend.callsTo('POST', '/leads/lead-1/accept');
  const firstKey = first?.headers['idempotency-key'];
  const secondKey = second?.headers['idempotency-key'];
  expect(firstKey).toBeTruthy();
  expect(secondKey).toBe(firstKey);
});

test('成功后再发起新的接受动作使用新键', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/icps', [ICP]);
  backend.set('GET', '/leads', [LEAD]);
  backend.set('POST', '/leads/lead-1/accept', {
    accepted: true,
    eventId: 'evt-1',
  });

  await loginAs(page);
  await page.goto('/leads');
  await page
    .locator('.ld__lead')
    .filter({ hasText: 'Muster Metallbau GmbH' })
    .getByRole('button', { name: '值得跟进' })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '确认跟进' }).click();
  await expect.poll(() => backend.callsTo('POST', '/leads/lead-1/accept').length, {
    timeout: 5000,
  }).toBe(1);
  const firstKey = backend.callsTo('POST', '/leads/lead-1/accept')[0]?.headers['idempotency-key'];
  expect(firstKey).toBeTruthy();
  // 再次打开并提交（同一 lead 的第二个逻辑动作）——键必须不同。
  await page
    .locator('.ld__lead')
    .filter({ hasText: 'Muster Metallbau GmbH' })
    .getByRole('button', { name: '值得跟进' })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: '确认跟进' }).click();
  await expect.poll(() => backend.callsTo('POST', '/leads/lead-1/accept').length, {
    timeout: 5000,
  }).toBe(2);
  const secondKey = backend.callsTo('POST', '/leads/lead-1/accept')[1]?.headers['idempotency-key'];
  expect(secondKey).toBeTruthy();
  expect(secondKey).not.toBe(firstKey);
});

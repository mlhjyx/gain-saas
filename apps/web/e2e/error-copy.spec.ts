/**
 * M2 步 14-3（设计 §5 第 10 条）：错误文案三层 + 技术详情折叠。
 *
 * 用 402「执行预算已用完」触发一次真实渲染路径（商机页加载失败 → ErrorNotice），
 * 断言「发生了什么 / 为什么 / 怎么办」三层齐全，错误码只出现在默认收起的「技术详情」里。
 */
import { expect, test } from '@playwright/test';

import { errorPayload, installMockBackend, loginAs } from './support/mock-backend';

test('错误三层文案 + 技术详情折叠（402 执行预算已用完）', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/qgos', async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify(
        errorPayload('EXECUTION_BUDGET_AUTHORITY_EXHAUSTED', {
          next: '联系运营追加预算后再继续。',
          title: '执行预算已用完',
          why: '该工作空间本期的执行额度已经耗尽。',
        }),
      ),
      contentType: 'application/json',
      status: 402,
    });
    return true;
  });

  await loginAs(page);
  await page.goto('/qgos');

  // 发生了什么 / 为什么 / 怎么办
  await expect(page.getByRole('heading', { name: '执行预算已用完' })).toBeVisible();
  await expect(page.getByText('该工作空间本期的执行额度已经耗尽。')).toBeVisible();
  await expect(page.getByText('联系运营追加预算后再继续。', { exact: true })).toBeVisible();

  // 技术详情：默认收起，错误码展开后可见
  const details = page.locator('details.error-notice__details');
  await expect(details.locator('summary')).toHaveText('技术详情');
  await expect(details.locator('code')).toHaveText('EXECUTION_BUDGET_AUTHORITY_EXHAUSTED');
  await expect(details.locator('code')).not.toBeVisible();
  await details.locator('summary').click();
  await expect(details.locator('code')).toBeVisible();
});

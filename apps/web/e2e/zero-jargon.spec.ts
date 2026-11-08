/**
 * M2 步 14-3（设计 §5 第 9 条）：零术语文本扫描。
 *
 * 与 scripts/lint-forbidden-terms.mjs（静态源码）互备：这里在真实渲染后的
 * 可见文本（innerText，折叠的技术详情不算）上扫同一份禁用词口径。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const BANNED = [
  { id: 'run', re: /\bruns?\b|\brun[_A-Z]\w*/i },
  { id: 'icp', re: /\bICPs?\b|\bicp[_A-Z]\w*/i },
  { id: 'canonical', re: /\bcanonical\w*/i },
  { id: 'plan_hash', re: /plan[_-]?hash/i },
  { id: 'uuid', re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
  { id: 'enum', re: /\b(PARTIAL|FAILED|RISKY)\b/ },
];

const PAGES = [
  '/workspace',
  '/companies',
  '/find-buyers',
  '/leads',
  '/growth',
  '/growth?tab=opportunities',
  '/growth?tab=outreach',
  '/settings/members',
  '/settings/suppressions',
  '/settings/workspaces',
  '/settings/privacy',
  '/settings/audit',
  '/settings/sources',
  '/reports',
  '/qgos',
  '/campaigns',
];

test('零术语扫描：全部租户页面的可见文本不含禁用词', async ({ page }) => {
  test.setTimeout(180_000);
  await installMockBackend(page);
  await loginAs(page);

  const offenders: string[] = [];
  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(400);
    const text = await page.locator('body').innerText();
    for (const pattern of BANNED) {
      const match = text.match(pattern.re);
      if (match) offenders.push(`${path}: [${pattern.id}] "${match[0]}"`);
    }
  }
  expect(offenders, `零术语红线命中：\n${offenders.join('\n')}`).toEqual([]);
});

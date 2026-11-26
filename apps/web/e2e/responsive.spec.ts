/**
 * M2 步 14-4（设计 §6）：窄屏布局冒烟。
 *
 * 两个 project 跑同一份用例：mobile（390×844，抽屉导航）与 tablet（820×1180，
 * 侧栏自动收成图标窄栏）。逐页检查两件事：
 *  - 文档无横向溢出；
 *  - 内容区（main，自身可滚动）无横向溢出——内容区是 overflow-x:hidden，
 *    里面的表格/卡片被裁掉时文档级宽度不会变，只量文档会漏掉（2026-11-25 平板实测）。
 * 覆盖全部一级导航页、「商机与触达」三个 tab、线索详情与其页签。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const PAGES = [
  '/workspace',
  '/analytics',
  '/companies',
  '/find-buyers',
  '/tasks',
  '/leads',
  '/leads?view=reviews',
  '/leads/lead-1',
  '/leads/lead-1?tab=people',
  '/outreach',
  '/outreach?tab=batches',
  '/outreach?tab=replies',
  '/opportunities',
  '/settings/members',
  '/settings/suppressions',
];

test('窄屏布局冒烟：文档与内容区均无横向溢出、主内容可见', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const tablet = testInfo.project.name === 'tablet';
  await installMockBackend(page);
  await loginAs(page);

  const offenders: string[] = [];
  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState('networkidle').catch(() => {});
    // 等 Vben 的页面加载过渡结束、真实内容渲染出来（过渡期间量到的是空页面）
    await page.locator('.loading').first().waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
    await page
      .waitForFunction(() => (document.querySelector('main')?.innerText.trim().length ?? 0) > 10, undefined, {
        timeout: 8000,
      })
      .catch(() => {});
    const measured = await page.evaluate(() => {
      const doc = document.documentElement;
      const main = document.querySelector('main');
      return {
        docClient: doc.clientWidth,
        docScroll: doc.scrollWidth,
        mainClient: main?.clientWidth ?? 0,
        mainScroll: main?.scrollWidth ?? 0,
      };
    });
    if (measured.docScroll > measured.docClient + 1) {
      offenders.push(`${path}: 文档横向溢出（scrollWidth ${measured.docScroll} > ${measured.docClient}）`);
    }
    if (measured.mainScroll > measured.mainClient + 1) {
      offenders.push(`${path}: 内容区横向溢出（scrollWidth ${measured.mainScroll} > ${measured.mainClient}，右侧内容会被裁掉）`);
    }
    const mainText = await page
      .locator('main')
      .innerText()
      .catch(() => '');
    if (mainText.trim().length < 10) offenders.push(`${path}: 主内容为空`);
  }
  // 导航形态：手机是抽屉（页面上没有常驻侧栏），平板是自动收起的图标窄栏。
  const nav = await page.evaluate(() => ({
    burger: Boolean(document.querySelector('.sdr-mobile-burger')),
    rail: Boolean(document.querySelector('.sdr-rail')),
  }));
  if (tablet) expect(nav, '平板宽度下侧栏应收成图标窄栏').toEqual({ burger: false, rail: true });
  else expect(nav, '手机宽度下应使用抽屉导航').toEqual({ burger: true, rail: false });
  expect(offenders, offenders.join('\n')).toEqual([]);
});

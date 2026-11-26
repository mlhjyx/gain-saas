/**
 * 体验问题第二轮（2026-11-26）：买家画像的术语、改名与分组。
 * 全部走 BFF mock，不依赖引擎与数据库；编号沿用反馈清单（#7 #8 #9 #10 与交互建议 3）。
 */
import type { MockBackend, MockHandler } from './support/mock-backend';

import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const NOW = '2026-11-26T08:00:00.000Z';

const COMPANY = {
  businessEmail: 'sales@example.org',
  domain: 'example.org',
  id: 'c1',
  industry: '医疗设备',
  name: '深圳步安科技有限公司',
  status: 'ACTIVE',
  targetMarkets: ['US'],
  website: 'https://example.org',
};

/**
 * 一份还没激活的画像。companyAttributes 里同时有模型给的目标属性（product / trade_side / country）
 * 和引擎写入的输入血缘字段（inputBasis / marketBasis / inputProducts / modelSuggestedMarkets）。
 */
const PROFILE = {
  buyingCommittee: [{ concerns: ['预算审批周期长'], role: 'procurement', title: '采购经理' }],
  companyAttributes: {
    country: 'US',
    inputBasis: 'legacy_all_offerings',
    inputProducts: ['光学步态分析仪'],
    marketBasis: 'legacy_profile_floor',
    modelSuggestedMarkets: ['US'],
    product: '光学步态分析仪',
    trade_side: '买方',
  },
  companyId: 'c1',
  createdAt: NOW,
  exclusions: ['采购用途明确仅限临床诊断或常规临床服务的机构'],
  id: 'icp-1',
  name: '美国高校及学术医疗中心的步态研究实验室',
  painPoints: ['需要将步态的定性观察转化为可分析的数据'],
  personas: [{ goals: ['如期完成课题'], painPoints: ['设备交付周期长'], title: '采购经理' }],
  ruleLint: [] as string[],
  rules: [] as unknown[],
  status: 'HYPOTHESIS',
  targetMarkets: ['US'],
  triggerSignals: ['公开列出仪器采购计划'],
  valueProps: ['以已确认的主营产品回应研究机构对设备的需求'],
  version: 1,
};

function json(make: () => unknown): MockHandler {
  return async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify({ data: make() }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  };
}

function mockProfilePage(backend: MockBackend): void {
  backend.set('GET', '/companies', [COMPANY]);
  backend.set('GET', '/icps', json(() => [PROFILE]));
  backend.set('GET', '/icps/icp-1', json(() => PROFILE));
  backend.set('GET', '/icps/icp-1/query-plans', []);
  backend.set('GET', '/tasks', []);
}

test('建议 3：「买家画像」取代「找买家」，和「买家线索」放在同一个分组', async ({ page }) => {
  await installMockBackend(page);
  await loginAs(page);
  await page.goto('/find-buyers');

  await expect(page.getByRole('heading', { level: 1, name: '买家画像' })).toBeVisible();
  await expect(page.getByText('目标客户画像').first()).toHaveCount(0);

  // 侧栏：「买家画像」「买家线索」同在「线索」组，「获客」组只剩「公司档案」，没有「找买家」
  const nav = page.locator('[data-sdr-nav]');
  await expect(nav.getByRole('menuitem', { name: '公司档案' })).toBeVisible();
  await nav.getByText('线索', { exact: true }).click();
  await expect(nav.getByRole('menuitem', { name: '买家画像' })).toBeVisible();
  await expect(nav.getByRole('menuitem', { name: '买家线索' })).toBeVisible();
  await expect(nav.getByRole('menuitem', { name: '找买家' })).toHaveCount(0);
  await nav.getByRole('menuitem', { name: '买家画像' }).click();
  await page.waitForURL(/\/find-buyers$/);
});

test('#8 五个板块换成读得懂的说法，每个标题下有一行说明', async ({ page }) => {
  const backend = await installMockBackend(page);
  mockProfilePage(backend);
  await loginAs(page);
  await page.goto('/find-buyers');
  await page.getByRole('button', { name: '查看与调整' }).click();

  const overview = page.locator("[data-gs='icp-overview']");
  for (const [title, hint] of [
    ['客户难题', '对方现在哪里不好办'],
    ['采购信号', '出现什么迹象，说明对方准备买了'],
    ['不找的对象', '什么样的公司直接跳过'],
    ['我们的卖点', '我们能帮对方解决什么'],
    ['该找的人', '这单采购要对接哪些角色'],
  ]) {
    // 「客户难题」也是角色卡里的小标签，这里只看板块标题（取第一个）
    await expect(overview.getByText(title, { exact: true }).first()).toBeVisible();
    await expect(overview.getByText(hint, { exact: true })).toBeVisible();
  }
  // antd 的 Drawer 既不把 data-gs 透到 DOM 上，也没有 dialog 角色。先按标题确认抽屉确实打开了，
  // 否则下面的「不再出现」会在空集合上白白通过。
  await expect(
    page.getByRole('heading', { level: 2, name: '美国高校及学术医疗中心的步态研究实验室' }),
  ).toBeVisible();
  // 旧说法在整个页面上都不再出现
  for (const old of ['痛点', '触发信号', '排除条件', '价值主张', '买家委员会']) {
    await expect(page.getByText(old, { exact: true })).toHaveCount(0);
  }

  // 「该找的人」把 personas 和 buyingCommittee 按职务合并成一张卡
  const person = overview.locator('.fb-persona').filter({ hasText: '采购经理' });
  await expect(person).toHaveCount(1);
  await expect(person).toContainText('如期完成课题');
  await expect(person).toContainText('预算审批周期长');

  // 编辑表单里同样的标题和说明
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const edit = page.getByRole('dialog').filter({ hasText: '编辑买家画像' });
  await expect(edit).toBeVisible();
  await expect(edit.getByText('对方现在哪里不好办')).toBeVisible();
  await expect(edit.getByText('出现什么迹象，说明对方准备买了')).toBeVisible();
});

test('#7 目标公司属性不再出现英文字段名；画像依据单列并用白话写', async ({ page }) => {
  const backend = await installMockBackend(page);
  mockProfilePage(backend);
  await loginAs(page);
  await page.goto('/find-buyers');
  // 画像卡上的「N 个买家画像」原指角色数，改叫对接角色
  await expect(page.getByText('1 个对接角色').first()).toBeVisible();
  // 状态「假设」改为「待激活」
  await expect(page.getByText('待激活', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: '查看与调整' }).click();
  const overview = page.locator("[data-gs='icp-overview']");
  await expect(overview).toBeVisible();

  // 目标公司属性：字段都是中文
  for (const label of ['产品', '交易角色', '国家/地区']) {
    await expect(overview.getByText(label, { exact: true }).first()).toBeVisible();
  }
  for (const raw of ['product', 'trade_side', 'inputBasis', 'marketBasis', 'inputProducts', 'modelSuggestedMarkets']) {
    await expect(overview.getByText(raw, { exact: true })).toHaveCount(0);
  }
  // 内部代码换成白话
  await expect(overview.getByText('legacy_profile_floor')).toHaveCount(0);
  await expect(overview.getByText('legacy_all_offerings')).toHaveCount(0);

  // 画像依据
  await expect(overview.getByText('画像依据', { exact: true })).toBeVisible();
  const lineage = overview.locator('.fb-block').filter({ hasText: '画像依据' });
  await expect(lineage).toContainText('依据的产品');
  await expect(lineage).toContainText('光学步态分析仪');
  await expect(lineage).toContainText('档案里的全部产品');
  await expect(lineage).toContainText('公司档案里的市场');
  await expect(lineage).toContainText('AI 另建议的市场');

  // 目标市场不再只显示两位代码
  await expect(overview.locator('.fb-chip').filter({ hasText: /美国/ }).first()).toBeVisible();
});

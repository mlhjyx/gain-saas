/**
 * 体验问题第二轮（2026-11-26）：买家画像的术语、改名与分组，以及页内工作区。
 * 全部走 BFF mock，不依赖引擎与数据库；编号沿用反馈清单（#7 #8 #9 #10 #12 #13 与交互建议 3）。
 * antd 的 Drawer / Modal 不会把 data-gs 透到 DOM 上，弹层按 dialog 角色定位。
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

const ACTIVE_PROFILE = { ...PROFILE, id: 'icp-2', name: '欧洲光伏分销商', status: 'ACTIVE', version: 3 };

/** 一份待确认的方案：三个渠道、三组搜索；说明里混着引擎的内部代码。 */
const PLAN = {
  createdAt: NOW,
  estimatedVolume: 100,
  icpId: 'icp-2',
  id: 'plan-1',
  queries: [
    {
      keywords: ['university gait lab directory', 'biomechanics research facilities'],
      priority: 1,
      rationale:
        '先低成本建立美国研究型大学及其官网的机构清单，供后续归并校内实验室。大学入库本身不代表符合研究要求。[source_filter] 已移除 2 条规划查询: SOURCE_QUERY_BUDGET 2 条 icp_seed_gap: 行业已归一但无 CPV crosswalk ; icp_fit_warning: 未识别贸易侧（买方），默认按美国进口渠道 (importer)',
      source_class: 'public_web',
    },
    {
      filters: { country: 'US', industry: 'higher education' },
      keywords: ['human locomotion research laboratories'],
      priority: 2,
      rationale: '按行业名录找研究型大学。',
      source_class: 'industry_data',
    },
    {
      keywords: ['gait analysis equipment tender'],
      priority: 2,
      rationale: '通过大学研究中心和共享设施名录定位团队。icp_fit_warning: TED 仅覆盖 EU/EEA/UK 买方 (US)',
      source_class: 'ted',
    },
  ],
  status: 'DRAFT',
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

/** 画像页需要的数据：公司、画像列表、每份画像的详情与方案、任务列表。 */
function mockProfilePage(
  backend: MockBackend,
  profiles: Array<Record<string, unknown>> = [PROFILE],
  plans: Record<string, unknown[]> = {},
): void {
  backend.set('GET', '/companies', [COMPANY]);
  backend.set('GET', '/icps', json(() => profiles));
  for (const profile of profiles) {
    backend.set('GET', `/icps/${String(profile.id)}`, json(() => profile));
    backend.set('GET', `/icps/${String(profile.id)}/query-plans`, json(() => plans[String(profile.id)] ?? []));
  }
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
  // 工作区确实展示了这份画像，旧说法在整个页面上都不再出现
  await expect(
    page.getByRole('heading', { level: 2, name: '美国高校及学术医疗中心的步态研究实验室' }),
  ).toBeVisible();
  for (const old of ['痛点', '触发信号', '排除条件', '价值主张', '买家委员会']) {
    await expect(page.getByText(old, { exact: true })).toHaveCount(0);
  }

  // 「该找的人」把 personas 和 buyingCommittee 按职务合并成一张卡
  const person = overview.locator('.fb-persona').filter({ hasText: '采购经理' });
  await expect(person).toHaveCount(1);
  await expect(person).toContainText('如期完成课题');
  await expect(person).toContainText('预算审批周期长');

  // 编辑表单里同样的标题和说明
  await page.locator("[data-gs='icp-edit']").click();
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

test('#7 画像详情是页内工作区：不再弹抽屉，默认展示生效中的画像，可以切换', async ({ page }) => {
  const backend = await installMockBackend(page);
  mockProfilePage(backend, [PROFILE, ACTIVE_PROFILE], { 'icp-2': [PLAN] });
  await loginAs(page);
  await page.goto('/find-buyers');

  const workspace = page.locator("[data-gs='icp-workspace']");
  await expect(workspace).toBeVisible();
  await expect(workspace.getByRole('heading', { level: 2, name: ACTIVE_PROFILE.name })).toBeVisible();
  await expect(page.locator('.ant-drawer')).toHaveCount(0);
  // 列表里对应的那张卡标成当前画像
  await expect(page.locator('.icp-card--selected')).toHaveCount(1);

  // 两份画像时在工作区头部切换
  await workspace.locator('.ant-select').click();
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option')
    .filter({ hasText: PROFILE.name })
    .click();
  await expect(workspace.getByRole('heading', { level: 2, name: PROFILE.name })).toBeVisible();
});

test('#9 #12 没激活的画像只看内容和激活；下一步贴在底部引导激活', async ({ page }) => {
  const backend = await installMockBackend(page);
  let current: Record<string, unknown> = PROFILE;
  backend.set('GET', '/icps', json(() => [current]));
  backend.set('GET', '/icps/icp-1', json(() => current));
  backend.set('GET', '/icps/icp-1/query-plans', []);
  backend.set('GET', '/tasks', []);
  backend.set('POST', '/icps/icp-1/activate', json(() => {
    current = { ...PROFILE, status: 'ACTIVE', version: 2 };
    return current;
  }));
  await loginAs(page);
  await page.goto('/find-buyers');

  await expect(page.locator("[data-gs='icp-overview']")).toBeVisible();
  // 方案、寻源、资格规则都不出现，也不留「还没有」的空话
  await expect(page.locator("[data-gs='icp-plans']")).toHaveCount(0);
  await expect(page.locator("[data-gs='icp-runs']")).toHaveCount(0);
  await expect(page.locator("[data-gs='icp-advanced']")).toHaveCount(0);
  await expect(page.getByText('资格规则')).toHaveCount(0);
  // 也不留「还没有」的空话；画像卡上的方案、寻源两栏直接说要先激活
  await expect(page.getByText('还没有寻源方案')).toHaveCount(0);
  await expect(page.getByText('先激活买家画像').first()).toBeVisible();

  const next = page.locator("[data-gs='icp-next']");
  await expect(next).toContainText('下一步：激活买家画像');
  await expect(next).toContainText('确认上面的内容没问题后激活');
  // 贴在视口底部：页面在顶部时也看得见
  const box = await next.boundingBox();
  const viewport = page.viewportSize()!;
  expect(Math.abs(box!.y + box!.height - (viewport.height - 12))).toBeLessThan(2);

  await page.locator("[data-gs='icp-next-button']").click();
  expect(backend.callsTo('POST', '/icps/icp-1/activate')).toHaveLength(1);
  await expect(page.locator("[data-gs='icp-plans']")).toBeVisible();
  await expect(page.locator("[data-gs='icp-runs']")).toBeVisible();
  await expect(next).toContainText('下一步：生成寻源方案');
});

test('#13 寻源方案先给结论，按渠道看搜索词；内部代码收进技术详情', async ({ page }) => {
  const backend = await installMockBackend(page);
  const planState: Record<string, unknown> = { ...PLAN };
  mockProfilePage(backend, [ACTIVE_PROFILE], { 'icp-2': [planState] });
  backend.set('POST', '/query-plans/plan-1/confirm', json(() => {
    planState.status = 'READY';
    return planState;
  }));
  await loginAs(page);
  await page.goto('/find-buyers');

  const plans = page.locator("[data-gs='icp-plans']");
  await expect(plans.getByRole('heading', { level: 3, name: '寻源方案' })).toBeVisible();
  const plan = plans.locator('li.fb-plan');
  await expect(plan).toContainText('去 3 个渠道找，一共 3 组搜索，预计约 100 家');
  await expect(plan.locator('.fb-channel')).toHaveCount(3);
  // 搜索词默认收起，先看结论
  await expect(plan.locator('.fb-query')).toHaveCount(0);
  await expect(plan.getByText('university gait lab directory', { exact: true })).toHaveCount(0);

  const channel = plan.locator('.fb-channel').first();
  await channel.getByRole('button', { name: '看搜索词' }).click();
  const query = channel.locator('.fb-query');
  await expect(query.getByText('university gait lab directory', { exact: true })).toBeVisible();
  await expect(query.locator('.fb-notes')).toContainText('先低成本建立美国研究型大学');
  await expect(query.locator('.fb-notes')).toContainText('注意：未识别贸易侧');
  // 带内部代码的小句只在折叠的技术详情里（搜索词旁的技术详情、整份方案的原始数据），页面上看不到
  const leaked = plan.getByText('SOURCE_QUERY_BUDGET');
  expect(await leaked.count()).toBeGreaterThan(0);
  for (const item of await leaked.all()) await expect(item).toBeHidden();
  await expect(query.locator('details.fb-raw summary')).toHaveText('技术详情');

  // 下一步跟着方案状态走：待确认 → 确认
  const next = page.locator("[data-gs='icp-next']");
  await expect(next).toContainText('下一步：确认方案');
  await page.locator("[data-gs='icp-next-button']").click();
  expect(backend.callsTo('POST', '/query-plans/plan-1/confirm')).toHaveLength(1);
  await expect(next).toContainText('下一步：开始寻源');
});

test('#10 编辑画像是表单：属性按字段填，原始数据收在最后', async ({ page }) => {
  const backend = await installMockBackend(page);
  let current: Record<string, unknown> = PROFILE;
  let patch: Record<string, unknown> | null = null;
  backend.set('GET', '/icps', json(() => [current]));
  backend.set('GET', '/icps/icp-1', json(() => current));
  backend.set('GET', '/icps/icp-1/query-plans', []);
  backend.set('GET', '/tasks', []);
  backend.set('PATCH', '/icps/icp-1', async ({ body, route }) => {
    patch = body as Record<string, unknown>;
    current = { ...PROFILE, ...patch, version: 2 };
    await route.fulfill({
      body: JSON.stringify({ data: current }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });
  await loginAs(page);
  await page.goto('/find-buyers');
  await page.locator("[data-gs='icp-edit']").click();

  const edit = page.getByRole('dialog').filter({ hasText: '编辑买家画像' });
  await expect(edit).toBeVisible();
  await expect(edit.getByLabel('产品')).toHaveValue('光学步态分析仪');
  await expect(edit.getByLabel('交易角色')).toHaveValue('买方');
  await expect(edit.getByLabel('国家/地区')).toHaveValue('US');
  // 原始数据默认收起，但仍保留着引擎写入的字段
  const raw = edit.locator('details.fb-adv');
  await expect(raw).not.toHaveAttribute('open', '');
  await expect(raw.locator('textarea')).toHaveValue(/"inputBasis": "legacy_all_offerings"/);

  await edit.getByLabel('客户难题').fill('需要把数据搬到云端\n要和现有设备打通');
  await edit.getByRole('button', { name: '保存修改' }).click();
  expect(backend.callsTo('PATCH', '/icps/icp-1')).toHaveLength(1);
  expect(patch).toMatchObject({
    companyAttributes: PROFILE.companyAttributes,
    expectedVersion: 1,
    painPoints: ['需要把数据搬到云端', '要和现有设备打通'],
  });
  await expect(edit).toBeHidden();
  await expect(page.locator("[data-gs='icp-overview']")).toContainText('需要把数据搬到云端');
});

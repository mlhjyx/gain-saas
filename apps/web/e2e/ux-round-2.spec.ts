/**
 * 体验问题第二轮（2026-11-26）：买家画像的术语、改名与分组，以及页内工作区。
 * 全部走 BFF mock，不依赖引擎与数据库；编号沿用反馈清单（#7 #8 #9 #10 #12 #13 与交互建议 3）。
 * antd 的 Drawer / Modal 不会把 data-gs 透到 DOM 上，弹层按 dialog 角色定位。
 */
import type { MockBackend, MockHandler } from './support/mock-backend';

import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';
import { allowSourcing } from './support/sourcing-fixtures';

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

  // 侧栏的企业档案、画像、寻源与线索都在获客与筛选。
  const nav = page.locator('[data-sdr-nav]');
  await expect(nav.getByText('获客与筛选', { exact: true })).toBeVisible();
  await expect(nav.getByRole('menuitem', { name: '企业档案' })).toBeVisible();
  await expect(nav.getByRole('menuitem', { name: '买家画像' })).toBeVisible();
  await expect(nav.getByRole('menuitem', { name: '买家线索' })).toBeVisible();
  await expect(nav.getByRole('menuitem', { name: '寻源记录' })).toBeVisible();
  await expect(nav.getByRole('menuitem', { name: '找买家' })).toHaveCount(0);
  await nav.getByRole('menuitem', { name: '买家画像' }).click();
  await page.waitForURL(/\/find-buyers$/);
});

test('匹配条件合并采购角色，画像表单保留字段说明', async ({ page }) => {
  const backend = await installMockBackend(page);
  allowSourcing(backend, COMPANY.id);
  mockProfilePage(backend);
  await loginAs(page);
  await page.goto('/find-buyers');

  const overview = page.locator("[data-gs='icp-overview']");
  await expect(overview).not.toContainText('我们的卖点');
  await page.getByRole('tab', { name: '匹配条件' }).click();
  const matching = page.locator("[data-gs='icp-matching']");
  await expect(matching.getByText('客户难题', { exact: true })).toBeVisible();
  await expect(matching.getByText('采购信号', { exact: true })).toBeVisible();
  await matching.getByText('采购角色与场景', { exact: true }).click();
  const person = matching.locator('.fb-persona').filter({ hasText: '采购经理' });
  await expect(person).toHaveCount(1);
  await expect(person).toContainText('如期完成课题');
  await expect(person).toContainText('预算审批周期长');
  await page.locator("[data-gs='icp-edit']").click();
  const edit = page.getByRole('dialog').filter({ hasText: '编辑买家画像' });
  await expect(edit.getByText('对方现在哪里不好办')).toBeVisible();
  await expect(edit.getByText('出现什么迹象，说明对方准备买了')).toBeVisible();
});

test('画像目标市场使用地区名称，来源和版本按需展开', async ({ page }) => {
  const backend = await installMockBackend(page);
  mockProfilePage(backend);
  await loginAs(page);
  await page.goto('/find-buyers');
  await expect(page.getByText('待激活', { exact: true }).first()).toBeVisible();
  await expect(page.locator('[data-gs="icp-target-markets"]')).toHaveText('美国');
  await expect(page.getByText('档案里的全部产品')).toHaveCount(0);
  await page.getByRole('tab', { name: '匹配条件' }).click();
  const matching = page.locator("[data-gs='icp-matching']");
  await expect(matching.getByText('产品', { exact: true })).toBeVisible();
  await matching.getByText('画像版本与来源', { exact: true }).click();
  const lineage = matching.locator('details').filter({ hasText: '画像版本与来源' });
  await expect(lineage).toContainText('第 1 版');
  await expect(lineage).toContainText('档案里的全部产品');
  await expect(lineage).toContainText('公司档案里的市场');
  for (const raw of ['product', 'trade_side', 'inputBasis', 'marketBasis', 'inputProducts', 'modelSuggestedMarkets', 'legacy_profile_floor']) {
    await expect(matching.getByText(raw, { exact: true })).toHaveCount(0);
  }
});

test('默认显示生效画像，左栏切换保留对应地址', async ({ page }) => {
  const backend = await installMockBackend(page);
  mockProfilePage(backend, [PROFILE, ACTIVE_PROFILE], { 'icp-2': [PLAN] });
  await loginAs(page);
  await page.goto('/find-buyers');

  const workspace = page.locator("[data-gs='icp-workspace']");
  const switcher = page.locator("[data-gs='icp-profile-switcher']");
  await expect(workspace.getByRole('heading', { level: 2, name: ACTIVE_PROFILE.name })).toBeVisible();
  await expect(page.locator('.ant-drawer')).toHaveCount(0);
  await expect(switcher.getByRole('button', { name: new RegExp(ACTIVE_PROFILE.name) })).toHaveAttribute('aria-pressed', 'true');
  await switcher.getByRole('button', { name: new RegExp(PROFILE.name) }).click();
  await expect(page).toHaveURL(/\/find-buyers\?icp=icp-1$/);
  await expect(workspace.getByRole('heading', { level: 2, name: PROFILE.name })).toBeVisible();
});

test('草稿只提供启用操作，启用后跳到独立寻源方案入口', async ({ page }) => {
  const backend = await installMockBackend(page);
  allowSourcing(backend, COMPANY.id);
  let current: Record<string, unknown> = PROFILE;
  backend.set('GET', '/companies', [COMPANY]);
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
  await expect(page.locator("[data-gs='icp-next']")).toHaveCount(0);
  await expect(page.getByText('资格规则')).toHaveCount(0);
  expect(backend.callsTo('GET', '/icps/icp-1/query-plans')).toHaveLength(0);
  await page.getByRole('button', { name: '启用画像' }).click();
  await expect.poll(() => backend.callsTo('POST', '/icps/icp-1/activate').length).toBe(1);
  await expect(page.locator("[data-gs='icp-overview']")).toBeVisible();
  await expect(page.getByRole('link', { name: '制定寻源方案' })).toHaveAttribute('href', '/tasks?icp=icp-1&tab=plan');
});

test('寻源方案先给结论，按渠道查看搜索词，技术细节按需展开', async ({ page }) => {
  const backend = await installMockBackend(page);
  allowSourcing(backend, COMPANY.id);
  const planState: Record<string, unknown> = { ...PLAN };
  mockProfilePage(backend, [ACTIVE_PROFILE], { 'icp-2': [planState] });
  backend.set('POST', '/query-plans/plan-1/confirm', json(() => {
    planState.status = 'READY';
    return planState;
  }));
  await loginAs(page);
  await page.goto('/find-buyers');
  await page.getByRole('link', { name: '确认方案' }).click();
  const plan = page.locator("[data-gs='icp-plans']");
  await expect(plan.getByRole('heading', { level: 2, name: '寻源方案' })).toBeVisible();
  await expect(plan).toContainText('去 3 个渠道找，一共 3 组搜索');
  await expect(plan).toContainText('预计约 100 家');
  await expect(plan.locator('.plan-source')).toHaveCount(3);
  const channel = plan.locator('.plan-source').first();
  const keywords = channel.getByText(/university gait lab directory/);
  await expect(keywords).toBeHidden();
  await channel.locator('summary').first().click();
  await expect(keywords).toBeVisible();
  await expect(channel.getByText(/先低成本建立美国研究型大学/)).toBeVisible();
  await expect(channel.getByText(/注意：未识别贸易侧/)).toBeVisible();
  await expect(channel.getByText(/SOURCE_QUERY_BUDGET/)).toBeHidden();
  await expect(channel.getByText('技术详情', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认方案', exact: true }).click();
  await expect.poll(() => backend.callsTo('POST', '/query-plans/plan-1/confirm').length).toBe(1);
  await expect(page.getByRole('button', { name: '开始寻源', exact: true })).toBeVisible();
});

test('#10 编辑画像是表单：属性按字段填，原始数据收在最后', async ({ page }) => {
  const backend = await installMockBackend(page);
  allowSourcing(backend, COMPANY.id);
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
  await expect.poll(() => backend.callsTo('PATCH', '/icps/icp-1').length).toBe(1);
  await expect(edit).toBeHidden();
  expect(patch).toMatchObject({
    companyAttributes: PROFILE.companyAttributes,
    expectedVersion: 1,
    painPoints: ['需要把数据搬到云端', '要和现有设备打通'],
  });
  await page.getByRole('tab', { name: '匹配条件' }).click();
  await expect(page.locator("[data-gs='icp-matching']")).toContainText('需要把数据搬到云端');
});

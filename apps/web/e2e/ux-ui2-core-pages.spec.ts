/**
 * PR-UI2 核心业务页升级 E2E 回归（Attio / Clay / Stripe 现代 B2B 密度与双栏秩序）：
 * 1) /leads：默认高密度紧凑表格（1440×900 首屏可见 8+ 条、5 维微格 + Tooltip、Hover 操作）、
 *    切换卡片视图、点击行滑出 520px 右侧快审抽屉（连续翻页 + 证据 + 快捷决策 + 跳转完整档案）；
 * 2) /leads/:id：68:32 双栏对象页布局比例 + Sticky 属性/决策侧栏 + 切 Tab 保留 T0 外联草稿；
 * 3) /find-buyers：消灭重复标题、全屏唯一蓝色 Primary CTA、修复空版本号穿帮（无 `第 版`）、
 *    多画像 240px 左侧窄栏与单画像自动隐藏；
 * 4) /analytics：主标题「成效复盘」、0 原生 <select>、0 9999px 胶囊主按钮、0 虚线套娃、
 *    工程口径收入折叠区；
 * 5) 全局 Checkbox 复选框恢复利落 4px 方圆角（borderRadius === '4px'）。
 */
import type { MockHandler } from './support/mock-backend';

import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const NOW = '2026-11-26T10:00:00.000Z';
const ICP_ID = 'icp-ui2-1';
const ICP_ID_2 = 'icp-ui2-2';
const COMPANY_ID = 'co-ui2-1';

const PASS_TEXT = `聚合 judge-aggregate/v1：verdict=FIT，加权分=0.88，reasonCodes=
C1_MATERIAL pass（score 9）：官网产品线覆盖工业光伏逆变器与储能组件，与卖方主力产品高度一致。
C2_ROLE pass（score 8）：欧洲区域核心分销商，具备稳定采购与库存分销能力。
C3_PROCESS pass（score 8）：具备系统集成与测试交付能力。
C4_BUSINESS_MODEL pass（score 9）：以 B2B 批量进口分销为主，符合目标经营模式。
C5_SIZE pass（score 7）：员工约 120 人，落在目标企业规模区间。`;

const MIXED_TEXT = `聚合 judge-aggregate/v1：verdict=UNKNOWN，加权分=证据门先决，reasonCodes=EVIDENCE_GATE_UNKNOWN
C1_MATERIAL pass（score 8）：官网列出多家主流光伏逆变器品牌设备。
C2_ROLE weak（score 5）：以区域工程安装为主，兼有部分设备转售。
C3_PROCESS pass（score 7）：具备并网调试能力。
C4_BUSINESS_MODEL weak（score 5）：需核实采购模式是否为直采进口。
C5_SIZE unclear（score —）：公开网页未披露员工人数。`;

function makeLeads(count: number) {
  const companies = [
    ['Rhein Energie Handel AG', 'rhein-energie.de', '德国', '能源分销', 92, 'QUALIFIED', PASS_TEXT],
    ['Solar Italia Distribution S.r.l.', 'solar-italia.it', '意大利', '光伏分销', 88, 'REVIEW', PASS_TEXT],
    ['Nordwind Photovoltaik BV', 'nordwind-pv.nl', '荷兰', '储能分销', 85, 'REVIEW', PASS_TEXT],
    ['Iberia Green Supply S.A.', 'iberiagreen.es', '西班牙', '清洁能源', 82, 'DISCOVERED', PASS_TEXT],
    ['Alpen Solar Technik GmbH', 'alpen-solar.at', '奥地利', '太阳能设备', 76, 'REVIEW', MIXED_TEXT],
    ['Helios Kraftwerke AG', 'helios-kraft.ch', '瑞士', '能源工程', 74, 'DISCOVERED', MIXED_TEXT],
    ['Baltic Grid Wholesale UAB', 'balticgrid.lt', '立陶宛', '电力批发', 71, 'DISCOVERED', MIXED_TEXT],
    ['Danube Power Components Kft', 'danubepower.hu', '匈牙利', '逆变器代理', 69, 'REVIEW', MIXED_TEXT],
    ['Vistula Renewables Sp. z o.o.', 'vistula-ren.pl', '波兰', '光伏批发', 67, 'DISCOVERED', MIXED_TEXT],
    ['Loire Solaire Equipement SAS', 'loiresolaire.fr', '法国', '能源分销', 64, 'DISCOVERED', MIXED_TEXT],
  ] as const;

  return Array.from({ length: count }, (_, i) => {
    const [name, domain, country, industry, totalScore, status, reasons] =
      companies[i % companies.length]!;
    return {
      canonicalCompanyId: `canon-${i + 1}`,
      channelSummary: {
        decisionMakerCount: i < 4 ? 2 : 1,
        emails: [`procurement@${domain}`],
        forms: [`https://${domain}/contact`],
        phones: ['+49 211 900120'],
        socials: [{ platform: 'linkedin', url: `https://www.linkedin.com/company/${domain.split('.')[0]}` }],
        verifiedEmailCount: i < 5 ? 1 : 0,
      },
      company: { country, domain, employeeCount: 80 + i * 10, industry, name },
      createdAt: NOW,
      fitReasons: [reasons],
      fitVerdict: totalScore >= 80 ? 'FIT' : 'UNKNOWN',
      icpId: ICP_ID,
      id: `lead-ui2-${i + 1}`,
      queue: 'needs_review',
      scored: true,
      status,
      totalScore: totalScore / 100,
      updatedAt: NOW,
    };
  });
}

function rawJson(payload: unknown): MockHandler {
  return async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify(payload),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  };
}

test('1. /leads 同页研判、紧凑表格、卡片模式与窄屏快审', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  const backend = await installMockBackend(page);
  const leads = makeLeads(10);

  backend.set('GET', '/icps', [
    { companyId: COMPANY_ID, createdAt: NOW, id: ICP_ID, name: '欧洲光伏分销商', status: 'ACTIVE', version: 2 },
  ]);
  backend.set('GET', `/icps/${ICP_ID}/lead-queues`, {
    needs_review: 10,
    queueBasis: { fit_gate_preset: 0, human_accept: 1, human_reject: 0, score: 9 },
    recommended: 3,
    rejected: 1,
    sanctions_hold: 0,
    scored: true,
    suppressed: 0,
  });
  backend.set('GET', '/leads', leads);
  backend.set('GET', '/leads/lead-ui2-2/package', {
    company: {
      canonical_company_id: 'canon-2',
      city: 'Milan',
      country: '意大利',
      domain: 'solar-italia.it',
      name: 'Solar Italia Distribution S.r.l.',
    },
    company_channels: [
      { channel: 'email', email_type: 'department', status: 'public', value: 'procurement@solar-italia.it' },
    ],
    company_profile: { employee_count: 95, industry: '光伏分销', trade_role: 'distributor' },
    evidence: [
      { fetched_at: NOW, field: '官网产品目录：工业逆变器与储能系统批发', source_url: 'https://solar-italia.it/products' },
    ],
    fit: { reasons: [PASS_TEXT], verdict: 'FIT' },
    identifiers: { vat_id: 'IT09876543210' },
    lead_id: 'lead-ui2-2',
    sanctions: { screened_at: NOW, status: 'clear' },
    scores: { demand_proof: 0.85, fit: 0.92, intent: 0.8, reachability: 0.88, role: 0.9, total: 0.88 },
    status: 'REVIEW',
    valid_until: NOW,
  });

  await loginAs(page);
  await page.goto('/leads');
  await page.waitForLoadState('networkidle').catch(() => {});

  const workbench = page.locator('[data-gs="leads-review-workbench"]');
  const inlineReview = workbench.locator('[data-gs="lead-review-pane"]');
  await expect(workbench.locator('[data-gs="lead-review-row"]')).toHaveCount(10);
  await expect(inlineReview.getByRole('heading', { name: 'Rhein Energie Handel AG' })).toBeVisible();
  const nextBuyer = workbench.getByRole('button', { name: /Solar Italia Distribution/ });
  await nextBuyer.focus();
  await nextBuyer.press('Enter');
  await expect(inlineReview.getByRole('heading', { name: 'Solar Italia Distribution S.r.l.' })).toBeVisible();
  await expect(nextBuyer).toContainText('88');
  await expect(inlineReview.getByText('88', { exact: true })).toBeVisible();
  await expect(inlineReview).toContainText('官网产品目录：工业逆变器与储能系统批发');
  await expect(inlineReview.locator('[data-gs="quick-drawer-accept"]')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.locator('[data-gs="leads-display-table"]').click();
  // 1) 全局 Checkbox 圆角修复为 4px 方圆角（非 10px 圆圈）
  const checkboxRadius = await page
    .locator('.ant-checkbox-inner')
    .first()
    .evaluate((el) => getComputedStyle(el).borderRadius);
  expect(checkboxRadius).toBe('4px');

  // 2) 默认渲染高密度紧凑表，1440×900 首屏内可见至少 8 家买家
  const rows = page.locator('[data-gs="lead-row"]');
  await expect(rows).toHaveCount(10);
  const inViewportCount = await rows.evaluateAll((els) =>
    els.filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    }).length,
  );
  expect(inViewportCount, '1440×900 首屏应至少完整容纳 8 家买家').toBeGreaterThanOrEqual(8);

  // 3) 5 维微格指示器可见，悬停 Tooltip 展示人话五维评估且无机器码
  const secondRow = rows.filter({ hasText: 'Solar Italia Distribution S.r.l.' });
  await expect(secondRow).toContainText('88');
  const micro = secondRow.locator('[data-gs="lead-dims-micro"]');
  await expect(micro).toBeVisible();
  await micro.hover();
  const tooltip = page.locator('.ant-tooltip:visible');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('产品品类');
  await expect(tooltip).not.toContainText('C1_MATERIAL');

  // 4) 行尾快捷操作可用（跟进 / 排除 / 详情）
  await secondRow.hover();
  await expect(secondRow.locator('[data-gs="lead-accept"]')).toBeVisible();
  await expect(secondRow.locator('[data-gs="lead-reject"]')).toBeVisible();
  await expect(secondRow.locator('[data-gs="lead-package"]')).toBeVisible();

  // 5) 点击行滑出 520px 右侧快审抽屉
  await secondRow.click();
  const drawer = page.locator('[data-gs="lead-quick-drawer"]');
  await expect(drawer).toBeVisible();
  const drawerWrapper = page.locator('.gs-drawer .ant-drawer-content-wrapper');
  const drawerBox = await drawerWrapper.boundingBox();
  expect(Math.round(drawerBox?.width ?? 0)).toBe(520);
  await expect(drawer).toContainText('官网产品目录：工业逆变器与储能系统批发');
  await expect(drawer).toContainText('买家角色');
  await expect(page.locator('[data-gs="quick-drawer-accept"]')).toBeVisible();
  await expect(page.locator('[data-gs="quick-drawer-open-detail"]')).toBeVisible();

  // 关闭抽屉并验证可无缝切到卡片视图再切回表格视图
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  await page.locator('[data-gs="leads-display-card"]').click();
  await expect(page.locator('[data-gs="lead-card"]')).toHaveCount(10);
  await page.locator('[data-gs="leads-display-table"]').click();
  await expect(page.locator('[data-gs="lead-row"]')).toHaveCount(10);

  await page.setViewportSize({ height: 844, width: 390 });
  await secondRow.getByText('Solar Italia Distribution S.r.l.', { exact: true }).click();
  await expect(drawer).toBeVisible();
  await expect.poll(async () => {
    const box = await drawerWrapper.boundingBox();
    return box ? Math.round(box.x) : -1;
  }).toBe(0);
  await expect(drawerWrapper.locator('.ant-drawer-close')).toBeInViewport();
  const evidence = drawer.getByText('官网产品目录：工业逆变器与储能系统批发');
  await evidence.scrollIntoViewIfNeeded();
  await expect(evidence).toBeInViewport();
});

test('2. /leads/:id 68:32 双栏对象页 + Sticky 侧栏属性/决策 + 切 Tab 保 T0 草稿', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  const backend = await installMockBackend(page, { role: 'admin' });

  backend.set('GET', '/leads/lead-ui2-2/package', {
    company: {
      canonical_company_id: 'canon-2',
      city: 'Milan',
      country: '意大利',
      domain: 'solar-italia.it',
      name: 'Solar Italia Distribution S.r.l.',
    },
    company_channels: [
      { channel: 'email', email_type: 'department', status: 'public', value: 'sales@solar-italia.it' },
      { channel: 'phone', status: 'public', value: '+39 02 9988776' },
    ],
    company_profile: { employee_count: 95, industry: '光伏分销', trade_role: 'distributor' },
    evidence: [
      { fetched_at: NOW, field: '官网产品目录', source_url: 'https://solar-italia.it/products' },
    ],
    fit: { reasons: [PASS_TEXT], verdict: 'FIT' },
    identifiers: { vat_id: 'IT09876543210' },
    lead_id: 'lead-ui2-2',
    sanctions: { screened_at: NOW, status: 'clear' },
    scores: { demand_proof: 0.85, fit: 0.92, intent: 0.8, reachability: 0.88, role: 0.9, total: 0.88 },
    social_profiles: [
      { platform: 'linkedin', url: 'https://www.linkedin.com/company/solar-italia' },
      { platform: 'facebook', url: 'https://www.facebook.com/solar-italia-demo' },
      { platform: 'x', url: 'https://x.com/solar_italia_demo' },
      { platform: 'whatsapp', url: 'https://wa.me/39029988776' },
    ],
    status: 'REVIEW',
    valid_until: NOW,
  });
  backend.set('GET', '/canonical-companies/canon-2', {
    company: {
      contacts: [
        {
          contactPoints: [
            { id: 'pt-1', status: 'VALID', type: 'email', value: 'buyer@solar-italia.example', verifiedAt: NOW },
            { id: 'pt-2', status: 'UNVERIFIED', type: 'linkedin', value: 'https://www.linkedin.com/in/buyer-demo-profile' },
          ],
          fullName: 'Marco Bianchi',
          id: 'ct-1',
          title: 'Head of Procurement',
        },
      ],
      country: 'IT',
      domain: 'solar-italia.it',
      id: 'canon-2',
      name: 'Solar Italia Distribution S.r.l.',
    },
    evidence: [],
  });
  backend.set('GET', '/outreach/t0/touches', []);
  backend.set('GET', '/qgos', []);

  await loginAs(page);
  await page.goto('/leads/lead-ui2-2');
  await page.waitForLoadState('networkidle').catch(() => {});

  const mainCol = page.locator('[data-gs="lead-detail-main"]');
  const inspectorCol = page.locator('[data-gs="lead-detail-inspector"]');
  await expect(mainCol).toBeVisible();
  await expect(inspectorCol).toBeVisible();

  const mainBox = (await mainCol.boundingBox())!;
  const inspBox = (await inspectorCol.boundingBox())!;
  // 桌面双栏并排（左侧 68%，右侧 32%）
  expect(inspBox.x).toBeGreaterThan(mainBox.x + mainBox.width - 2);
  const ratio = mainBox.width / (mainBox.width + inspBox.width);
  expect(ratio).toBeGreaterThan(0.62);
  expect(ratio).toBeLessThan(0.73);

  // 右侧属性栏展示基础属性、公开渠道与管理员决策人预览
  await expect(inspectorCol.locator('[data-gs="inspector-properties"]')).toContainText('solar-italia.it');
  await expect(inspectorCol.locator('[data-gs="inspector-properties"]')).toContainText('IT09876543210');
  await expect(inspectorCol.locator('[data-gs="inspector-decision-makers"]')).toContainText('Marco Bianchi');

  // 切 Tab 保留 T0 草稿
  await page.locator('[data-gs="t0-subject"]').fill('UI2 Draft Kept Across Tabs');
  await page.getByRole('tab', { name: '联系人' }).click();
  const contact = page.locator('[data-gs="decision-maker"]').filter({ hasText: 'Marco Bianchi' });
  const contactChannels = contact.locator('[data-gs="person-contact-channels"]');
  await expect(contactChannels.locator('[data-channel="email"]')).toContainText('2026-11-26');
  await expect(contactChannels.locator('[data-channel="linkedin"]').getByRole('link')).toHaveAttribute(
    'href', 'https://www.linkedin.com/in/buyer-demo-profile',
  );
  await expect(contactChannels.locator('[data-channel="facebook"], [data-channel="x"], [data-channel="whatsapp"]')).toHaveCount(0);
  await contact.getByRole('button', { name: /查看.*LinkedIn.*渠道/ }).click();
  await expect(contactChannels.locator('[data-channel="linkedin"]')).toBeFocused();
  const publicChannels = page.locator('[data-gs="people-public-channels"]');
  for (const channel of ['linkedin', 'facebook', 'x', 'whatsapp', 'email', 'phone']) {
    await expect(publicChannels.locator(`[data-channel="${channel}"]`)).toBeVisible();
  }
  await page.setViewportSize({ height: 844, width: 390 });
  await expect(contactChannels.locator('[data-channel="email"]')).toBeVisible();
  expect(await page.locator('main').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await page.getByRole('tab', { name: '触达草稿' }).click();
  await expect(page.locator('[data-gs="t0-subject"]')).toHaveValue('UI2 Draft Kept Across Tabs');
});

test('合规待核的同页研判不会采用较宽松的列表摘要恢复联系入口', async ({ page }) => {
  const backend = await installMockBackend(page, { role: 'admin' });
  backend.set('GET', '/icps', [
    { companyId: COMPANY_ID, createdAt: NOW, id: ICP_ID, name: '欧洲光伏分销商', status: 'ACTIVE' },
  ]);
  const [lead] = makeLeads(1);
  backend.set('GET', '/leads', [{ ...lead, queue: 'sanctions_hold', status: 'REVIEW' }]);
  backend.set('GET', '/leads/lead-ui2-1/package', {
    company: { name: lead!.company.name },
    company_channels: [],
    contact_points: [],
    lead_id: lead!.id,
    sanctions: { status: 'potential_match' },
    social_profiles: [],
    status: 'REVIEW',
  });
  await loginAs(page);
  await page.goto('/leads?queue=sanctions_hold');
  const pane = page.locator('[data-gs="lead-review-pane"]');
  await expect(pane.getByRole('heading', { name: lead!.company.name })).toBeVisible();
  await expect.poll(() => backend.callsTo('GET', '/leads/lead-ui2-1/package').length).toBeGreaterThan(0);
  await expect(pane.locator('[data-gs="quick-public-channels"]')).toHaveCount(0);
  await expect(pane.locator('[data-gs="quick-drawer-accept"]')).toHaveCount(0);
});

test('3. /find-buyers 单一主蓝按钮、无重复二级标题、修复空版本号穿帮与多画像左侧窄栏', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  const backend = await installMockBackend(page);

  const company = {
    id: COMPANY_ID,
    name: '盛光新能源科技有限公司',
    status: 'ACTIVE',
    targetMarkets: ['DE', 'IT'],
    website: 'https://shengguang.example',
  };
  // 故意令 version 为 undefined 验证不出现「第 版」穿帮
  const icpNoVersion = {
    buyingCommittee: [],
    companyAttributes: { country: 'DE', industry: 'Solar PV' },
    companyId: COMPANY_ID,
    createdAt: NOW,
    exclusions: ['下游终端户用安装商'],
    id: ICP_ID,
    name: '欧洲工商业光伏分销商',
    painPoints: ['旺季供货周期不稳定'],
    personas: [{ goals: ['降低采购成本'], painPoints: ['交期长'], title: '采购总监' }],
    ruleLint: [],
    rules: [],
    status: 'ACTIVE',
    targetMarkets: ['DE', 'IT'],
    triggerSignals: ['新增仓储中心'],
    valueProps: ['欧洲本地仓现货交付'],
    version: undefined,
  };
  const icpSecond = {
    ...icpNoVersion,
    id: ICP_ID_2,
    name: '中东储能 EPC 总包',
    status: 'DRAFT',
    targetMarkets: ['AE'],
    version: 2,
  };

  backend.set('GET', '/companies', [company]);
  backend.set('GET', '/icps', [icpNoVersion, icpSecond]);
  backend.set('GET', `/icps/${ICP_ID}`, icpNoVersion);
  backend.set('GET', `/icps/${ICP_ID_2}`, icpSecond);
  backend.set('GET', `/icps/${ICP_ID}/query-plans`, [
    {
      createdAt: NOW,
      estimatedVolume: 80,
      icpId: ICP_ID,
      id: 'plan-ui2-1',
      queries: [{ keywords: ['solar inverter distributor germany'], source_class: 'public_web' }],
      status: 'READY',
      version: 1,
    },
  ]);
  backend.set('GET', `/icps/${ICP_ID_2}/query-plans`, []);
  backend.set('GET', '/tasks', []);

  await loginAs(page);
  await page.goto('/find-buyers');
  await page.waitForLoadState('networkidle').catch(() => {});

  // 1) 无重复「买家画像」二级标题
  await expect(page.getByRole('heading', { level: 1, name: '买家画像' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: '买家画像' })).toHaveCount(0);

  // 2) 全页仅 1 个可见蓝色 Primary CTA（当前状态的「下一步」）
  const primaryButtons = page.locator('[data-gs="icp-workspace"] [data-gs="icp-next-button"]:visible');
  await expect(primaryButtons).toHaveCount(1);
  await expect(primaryButtons.first()).toHaveAttribute('data-gs', 'icp-next-button');

  // 3) 空版本号不穿帮（绝不出现「第 版」）
  const bodyText = await page.locator('main').innerText();
  expect(bodyText).not.toMatch(/第\s+版/);
  await expect(page.locator('[data-gs="icp-workspace-meta"]')).toHaveText('盛光新能源科技有限公司 · 企业档案');

  const rail = page.locator('[data-gs="icp-profile-switcher"]');
  await expect(rail.getByRole('button')).toHaveCount(2);
  const railBox = (await rail.boundingBox())!;
  expect(railBox.width).toBeGreaterThan(160);
  expect(railBox.width).toBeLessThan(340);

  backend.set('GET', '/icps', [icpNoVersion]);
  await page.reload();
  await expect(rail.getByRole('button')).toHaveCount(1);
  await expect(primaryButtons).toHaveCount(1);

});

test('4. /analytics 标题「成效复盘」、0 原生 select、0 9999px 胶囊主按钮与白话化空态', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1440 });
  const backend = await installMockBackend(page);
  backend.set('GET', '/metrics/vric', rawJson({ data: [], page: { has_more: false, next_cursor: null } }));
  backend.set('GET', '/metrics/catalog', rawJson({ data: [], page: { has_more: false, next_cursor: null } }));

  await loginAs(page);
  await page.goto('/analytics');
  await page.waitForLoadState('networkidle').catch(() => {});

  // 1) 主标题统一为「成效复盘」，不再出现旧标题「度量」
  await expect(page.getByRole('heading', { level: 1, name: '成效复盘' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '度量' })).toHaveCount(0);

  // 2) 0 原生 <select>
  await expect(page.locator('select')).toHaveCount(0);
  await expect(page.locator('[data-gs="select"]').first()).toBeVisible();

  // 3) 0 9999px 大胶囊主按钮，统一 8px 圆角
  const pillButtons = await page.locator('main button:visible').evaluateAll((btns) =>
    btns
      .map((btn) => ({
        radius: Number.parseFloat(getComputedStyle(btn).borderRadius) || 0,
        text: btn.textContent?.trim() ?? '',
      }))
      .filter((item) => item.radius >= 100),
  );
  expect(pillButtons, '成效复盘页不应存在 9999px 椭圆大胶囊按钮').toEqual([]);

  // 4) 主视觉不含内部黑话（VRIC 等仅在折叠的「数据口径说明」内）
  const visibleText = await page.locator('main').innerText();
  expect(visibleText).toContain('寻源可达与转化趋势');
  expect(visibleText).toContain('暂无统计数据');
  expect(visibleText).not.toContain('VRIC');

  const methodology = page.locator('[data-gs="analytics-methodology"]');
  await expect(methodology).not.toHaveAttribute('open', '');
  await methodology.locator('summary').click();
  await expect(methodology).toContainText('VRIC');
});

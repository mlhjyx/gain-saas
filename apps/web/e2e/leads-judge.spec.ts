/**
 * 判定聚合文本（C1–C5）的呈现契约（2026-11-23）。
 *
 * 引擎回的是「judge-aggregate/v1：verdict=…，reasonCodes=…」+ 五行判据原文。
 * 这个用例用真实形状的数据锁住两件事：
 *  1) 列表与详情只显示业务语言（五维名称/结论/分数/理由），聚合原文与机器码
 *     只能出现在「技术详情」折叠区；
 *  2) 详情页画出五维雷达图，展开区能看到逐维理由。
 * 同时输出明暗两套视觉证据。
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const NOW = '2026-11-08T10:12:30.000Z';

const JUDGE_TEXT = `聚合 judge-aggregate/v1：verdict=UNKNOWN，加权分=证据门/硬门先决，reasonCodes=EVIDENCE_GATE_UNKNOWN
C1_MATERIAL pass（score 8）：候选官网列出多个太阳能品牌设备（ENPHASE、LONGi、JA SOLAR、SOLIS、BYD），品类与 ICP 太阳能逆变器、组件等一致；但仅有品牌名，未展示具体品类词与工艺词，故给 8 分。
C2_ROLE fail（score 3）：候选官网明确描述为安装服务商（crew installs），而非分销/批发/进口商；虽列出第三方品牌，但无转售或采购描述，角色为下游服务商而非买家/经销商，买方角色弱，给 3 分。
C3_PROCESS fail（score 0）：候选官网仅展示安装、调试和监控服务，无任何制造/加工能力描述，不符合 ICP 对逆变器等产品的工艺要求，给 0 分。
C4_BUSINESS_MODEL fail（score 2）：候选商业模式为太阳能系统安装服务（service），无采购并转售实物产品的分销/批发证据，与 ICP 要求的进口商/经销商模式相反，给 2 分。
C5_SIZE unclear（score —）：候选快照中未提供员工数或规模数据，无法评估与 ICP 员工范围（5-200）的匹配度。`;

const PASS_TEXT = `聚合 judge-aggregate/v1：verdict=FIT，加权分=0.86，reasonCodes=
C1_MATERIAL pass（score 9）：官网产品线覆盖逆变器与组件，品类高度一致。
C2_ROLE pass（score 8）：官网明确为区域分销商，有采购与转售描述。
C3_PROCESS pass（score 8）：具备逆变器组装与测试能力。
C4_BUSINESS_MODEL pass（score 9）：以批发进口为主，符合目标模式。
C5_SIZE pass（score 7）：员工约 120 人，落在目标区间。`;

const ICP = {
  createdAt: NOW,
  id: 'icp-1',
  name: '欧洲太阳能进口商',
  status: 'ACTIVE',
  updatedAt: NOW,
};

const LEAD_LOW = {
  canonicalCompanyId: 'c1',
  company: {
    country: '奥地利',
    domain: 'alpen-solar.at',
    employeeCount: 24,
    industry: '太阳能设备',
    name: 'Alpen Solar Technik GmbH',
  },
  createdAt: NOW,
  fitReasons: [JUDGE_TEXT],
  fitVerdict: 'UNKNOWN',
  icpId: 'icp-1',
  id: 'lead-1',
  queue: 'needs_review',
  scored: true,
  status: 'DISCOVERED',
  totalScore: 46,
  updatedAt: NOW,
};

const LEAD_HIGH = {
  canonicalCompanyId: 'c2',
  company: {
    country: '德国',
    domain: 'rhein-energie.de',
    employeeCount: 120,
    industry: '能源分销',
    name: 'Rhein Energie Handel AG',
  },
  createdAt: NOW,
  fitReasons: [PASS_TEXT],
  fitVerdict: 'match',
  icpId: 'icp-1',
  id: 'lead-2',
  queue: 'recommended',
  scored: true,
  status: 'QUALIFYING',
  totalScore: 88,
  updatedAt: NOW,
};

const LEAD_SCORES = {
  canonicalCompanyId: 'c3',
  company: {
    country: '荷兰',
    domain: 'nordwind-solar.nl',
    employeeCount: 48,
    industry: '光伏分销',
    name: 'Nordwind Solar BV',
  },
  createdAt: NOW,
  fitVerdict: 'weak',
  icpId: 'icp-1',
  id: 'lead-3',
  queue: 'needs_review',
  scored: true,
  scores: {
    demand_proof: 0.4,
    fit: 0.9,
    intent: 0.5,
    reachability: 0.7,
    role: 0.8,
  },
  status: 'DISCOVERED',
  totalScore: 74,
  updatedAt: NOW,
};

const PACKAGE = {
  company: {
    canonical_company_id: 'c1',
    city: 'Innsbruck',
    country: '奥地利',
    domain: 'alpen-solar.at',
    name: 'Alpen Solar Technik GmbH',
  },
  company_profile: { trade_role: 'installer', industry: 'solar' },
  contact_points: [
    { kind: 'website', status: 'company_level', url: 'https://alpen-solar.at/kontakt' },
  ],
  evidence: [
    {
      fetched_at: NOW,
      field: '官网业务描述',
      source_url: 'https://alpen-solar.at/about',
    },
  ],
  fit: { reasons: [JUDGE_TEXT], verdict: 'UNKNOWN' },
  identifiers: {},
  lead_id: 'lead-1',
  sanctions: { screened_at: NOW, status: 'clear' },
  scores: {
    demand_proof: 0.3,
    engagement: 0.2,
    fit: 0.5,
    intent: 0.4,
    reachability: 0.7,
    role: 0.3,
    total: 0.46,
  },
  status: 'DISCOVERED',
  valid_until: NOW,
};

test('五维判定在列表/详情只展示业务语言，雷达图可读', async ({ context, page }) => {
  // 「复制官网域名」走 navigator.clipboard，需要显式授权
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const backend = await installMockBackend(page);
  backend.set('GET', '/icps', [ICP]);
  backend.set('GET', '/leads', [LEAD_LOW, LEAD_HIGH, LEAD_SCORES]);
  backend.set('GET', '/icps/icp-1/query-plans', [
    { createdAt: NOW, icpId: 'icp-1', id: 'plan-1', queries: [], status: 'EXECUTED', version: 1 },
  ]);
  // 线索已经产出：方案执行过、最近一轮寻源已完成，步骤条落在第 5 步「判断线索」（存档截图以此为准）。
  backend.set('GET', '/tasks', [
    {
      id: 'task-1',
      name: '欧洲太阳能进口商 · 挖掘任务',
      runs: [{ finishedAt: NOW, id: 'tr-1', planId: 'plan-1', runId: 'run-1', startedAt: NOW, status: 'DONE' }],
      status: 'active',
    },
  ]);
  backend.set('GET', '/icps/icp-1/lead-queues', {
    needs_review: 2,
    queueBasis: { fit_gate_preset: 0, human_accept: 0, human_reject: 0, score: 2 },
    recommended: 0,
    rejected: 0,
    sanctions_hold: 0,
    scored: true,
    suppressed: 0,
  });
  backend.set('GET', '/leads/lead-1/package', PACKAGE);
  backend.set('GET', '/leads/lead-1/outreach-drafts', { data: null });

  await loginAs(page);
  await page.goto('/leads');
  await page.waitForLoadState('networkidle').catch(() => {});

  // 渐变页头 + 药丸页签（当前队列以 aria-pressed 标记）
  await expect(page.getByRole('heading', { level: 1, name: '买家线索' })).toBeVisible();
  await expect(page.locator("[data-gs='stage-steps']")).toBeVisible();
  // 当前步不显示序号（用户看不懂「5」指什么），用圆点标记
  await expect(
    page.locator("[data-gs='stage-steps'] .ant-steps-icon").filter({ hasText: /\d/ }),
  ).toHaveCount(0);
  await expect(page.locator("[data-gs='stage-steps']").getByText('判断线索')).toBeVisible();
  await expect(
    page.locator("[data-gs='queue-switch'] [aria-pressed='true']"),
  ).toHaveText(/待我判断\s*2/);

  const low = page.locator("[data-gs='lead-card']").filter({ hasText: 'Alpen Solar Technik' });
  await expect(low).toBeVisible();
  await expect(low.getByRole('button', { name: '跟进', exact: true })).toBeVisible();
  await expect(low.getByRole('button', { name: '排除', exact: true })).toBeVisible();

  // 宽屏（内容区 ≥ ~1200px）五列并排：按用户实际视口宽度留证
  await page.setViewportSize({ height: 993, width: 1586 });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: 'docs/evidence/ui-restyle/antd-system/leads-judge-wide-light.png',
  });
  await page.setViewportSize({ height: 900, width: 1440 });
  await page.waitForTimeout(300);
  // 五维业务名齐全，机器原文绝不直接上屏
  for (const name of ['产品品类', '买家角色', '生产工艺', '经营模式', '企业规模']) {
    await expect(low.getByText(name, { exact: true })).toBeVisible();
  }
  const cardText = await low.innerText();
  expect(cardText).not.toContain('C1_MATERIAL');
  expect(cardText).not.toContain('judge-aggregate');
  expect(cardText).not.toContain('EVIDENCE_GATE_UNKNOWN');
  expect(cardText).not.toMatch(/\bICP\b/);

  // 第二条（全维通过）走同一套渲染：高分与结论摘要都在
  const high = page.locator("[data-gs='lead-card']").filter({ hasText: 'Rhein Energie Handel' });
  await expect(high.getByText('高价值', { exact: true })).toBeVisible();
  // 机器结论 FIT → 药丸「值得跟进」（与队列名同词，这里是结论而不是队列标签）
  await expect(high.getByText('值得跟进', { exact: true })).toBeVisible();

  // 旧线索只有八维评分、没有聚合文本：降级为「评分维度」小条，不留空列
  const scoresOnly = page
    .locator("[data-gs='lead-card']")
    .filter({ hasText: 'Nordwind Solar' });
  await expect(scoresOnly.getByText('评分维度', { exact: true })).toBeVisible();
  await expect(scoresOnly.getByText('90', { exact: true })).toBeVisible();

  // 展开：逐维理由 + 技术详情（机器码只在折叠区）
  await low.getByRole('button', { name: '展开' }).click();
  const detail = low.locator("[data-gs='lead-detail']");
  await expect(detail).toBeVisible();
  await expect(detail.getByText('买家角色', { exact: true })).toBeVisible();
  await expect(detail.getByText('证据不足', { exact: false }).first()).toBeVisible();
  // 维度计数摘要只在展开区（折叠态保持一行原因，不堆数字）
  await expect(detail.getByText('1 项符合 · 3 项不符 · 1 项证据不足')).toBeVisible();

  await page.setViewportSize({ height: 1800, width: 1440 });
  await page.screenshot({
    fullPage: true,
    path: 'docs/evidence/ui-restyle/antd-system/leads-judge-light.png',
  });
  await page.setViewportSize({ height: 900, width: 1440 });

  await detail.getByText('技术详情').click();
  await expect(detail.getByText('EVIDENCE_GATE_UNKNOWN').first()).toBeVisible();

  // 详情：雷达图 + 五维明细
  await page.goto('/leads/lead-1');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Alpen Solar Technik GmbH' }),
  ).toBeVisible();
  const radar = page.getByRole('img', { name: /五维匹配图/ });
  await expect(radar).toBeVisible();
  await expect(page.locator("[data-gs='judge-dimensions']")).toBeVisible();
  await expect(page.locator("[data-gs='judge-dimensions']").getByText('买家角色')).toBeVisible();
  await page.screenshot({
    fullPage: true,
    path: 'docs/evidence/ui-restyle/antd-system/leads-detail-judge-light.png',
  });

  // 深色主题：同一屏再拍一张，确认雷达/评分/维度色都跟主题走
  await page.getByRole('button', { name: 'dark' }).click();
  await page.waitForTimeout(800);
  await page.screenshot({
    fullPage: true,
    path: 'docs/evidence/ui-restyle/antd-system/leads-detail-judge-dark.png',
  });
  await page.goto('/leads');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.screenshot({
    fullPage: true,
    path: 'docs/evidence/ui-restyle/antd-system/leads-judge-dark.png',
  });
  await page.setViewportSize({ height: 993, width: 1586 });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: 'docs/evidence/ui-restyle/antd-system/leads-judge-wide-dark.png',
  });

  // 「⋯」更多操作必须真的弹出菜单：antdv 的 Dropdown 只认 #overlay，
  // 按 React 版的 :menu 写法会得到一个打开了的空弹层（点击后毫无反应）。
  const lowAgain = page
    .locator("[data-gs='lead-card']")
    .filter({ hasText: 'Alpen Solar Technik' });
  const more = lowAgain.getByRole('button', { name: '更多操作' });
  await more.click();
  const menu = page.locator('.ant-dropdown:visible').getByRole('menu');
  await expect(menu).toBeVisible();
  // 「查看档案包」是卡片上的可见按钮（2026-11-26 体验问题 #26），菜单里只留复制官网
  await expect(menu.getByRole('menuitem')).toHaveText(['复制官网域名']);
  await menu.getByRole('menuitem', { name: '复制官网域名' }).click();
  await expect(page.getByText('已复制官网域名')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('alpen-solar.at');

  await lowAgain.getByRole('button', { name: '查看档案包' }).click();
  await page.waitForURL(/\/leads\/lead-1$/);
});

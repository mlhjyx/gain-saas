/**
 * M2 步 14-3：Playwright 主链路用例（设计 §5）。
 *
 * 全部走 BFF mock（support/mock-backend），不依赖引擎与数据库；mock 的应答形状取自
 * apps/web/src/api/gainos.ts 的接口类型。触达（设计第 6 条）与禁联名单增删（第 8 条增删侧）
 * 依赖步 11 的控制面页面，暂以 fixme 挂起，上线后转正。
 */
import type { CampaignDetail } from '../src/api/gainos';

import { expect, test } from '@playwright/test';

import type { MockBackend, MockHandler } from './support/mock-backend';

import { installMockBackend, loginAs } from './support/mock-backend';
import { allowSourcing } from './support/sourcing-fixtures';

const NOW = '2026-11-08T08:00:00.000Z';

const ICP = {
  buyingCommittee: [],
  companyAttributes: {},
  companyId: 'c1',
  createdAt: NOW,
  exclusions: [],
  id: 'icp-1',
  name: '德国五金进口商',
  painPoints: [],
  personas: [{ goals: [], painPoints: [], title: '采购经理' }],
  ruleLint: [],
  rules: [],
  status: 'ACTIVE',
  targetMarkets: ['DE'],
  triggerSignals: [],
  valueProps: [],
  version: 1,
};

const COMPANY = {
  businessEmail: 'sales@example.org',
  domain: 'example.org',
  id: 'c1',
  industry: '五金工具',
  name: '宁波宏达机电有限公司',
  status: 'ACTIVE',
  summary: '出口德系五金工具的分销商',
  targetMarkets: ['DE'],
  website: 'https://example.org',
};

/** 动态数据端点：每次请求时求值，用闭包状态模拟服务端状态机。 */
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

async function settle(page: import('@playwright/test').Page, ms = 600): Promise<void> {
  await page.waitForTimeout(ms);
}

test('主链路 1：注册 → 工作台启航清单 → 完成建档', async ({ page }) => {
  const backend = await installMockBackend(page, { onboardingComplete: false });
  await page.goto('/auth/register');
  await page.locator('input[type="text"]').first().fill('E2E 测试公司');
  await page.locator('input[type="email"]').fill('e2e@gainos.local');
  await page.locator('input[type="password"]').fill('e2e-password-123');
  await page.locator('button.g-submit').click();

  // 注册先进入工作台，再从启航清单提交官网并确认资料
  await page.waitForURL(/\/workspace$/);
  await expect(page.getByRole('heading', { name: '企业启航清单' })).toBeVisible();
  await page.locator('input[placeholder*="https://"]').fill('https://example.org');
  await page.getByRole('button', { name: '开始后台分析' }).click();

  // 理解预览：行业/产品候选默认勾选；目标市场只展示建议、不默认勾选，客户确认后提交。
  await expect(page.getByText('我们读完了官网')).toBeVisible();
  await expect(page.getByRole('button', { name: /LED 灯具/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: '完成建档' }).click();

  await expect(page.getByRole('link', { name: '建立首个买家画像' })).toBeVisible();
  const call = backend.take('POST', '/onboarding/company');
  expect(call, '应向 BFF 提交建档').toBeTruthy();
  const body = call!.body as {
    name?: string;
    industryCode?: string;
    products?: string[];
    targetMarkets?: string[];
  };
  expect(body.name).toBe('E2E 测试公司');
  expect(body.industryCode).toBe('28');
  expect(body.products).toEqual(['LED 灯具']);
  expect(body.targetMarkets).toEqual([]);
});

test('主链路 2：企业事实审批（通过所选）', async ({ page }) => {
  const backend = await installMockBackend(page);
  let claimStatus = 'NEEDS_REVIEW';
  backend.set('GET', '/companies', [COMPANY]);
  backend.set('GET', '/companies/c1', COMPANY);
  backend.set(
    'GET',
    '/companies/c1/completeness',
    json(() => ({
      approvedClaims: claimStatus === 'APPROVED' ? 1 : 0,
      conflictsOpen: 0,
      offerings: 0,
      pendingClaims: claimStatus === 'APPROVED' ? 0 : 1,
    })),
  );
  backend.set('GET', '/companies/c1/offerings', []);
  backend.set('GET', '/companies/c1/conflicts', []);
  backend.set(
    'GET',
    '/companies/c1/claims',
    json(() => [
      {
        companyId: 'c1',
        createdAt: NOW,
        id: 'claim-1',
        statement: '通过 IATF 16949 认证',
        status: claimStatus,
        type: 'capability',
        version: 1,
      },
    ]),
  );
  backend.set(
    'POST',
    '/claims/claim-1/approve',
    json(() => {
      claimStatus = 'APPROVED';
      return { id: 'claim-1', status: 'APPROVED' };
    }),
  );

  await loginAs(page);
  await expect(page.locator('[data-sdr-nav]').getByText('获客与筛选', { exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: '企业档案' }).click();
  await page.waitForURL(/\/companies/);
  // 企业事实是页内工作台，进入页面后自动加载，不需要再点开弹窗。
  await expect(page.locator('[data-gs="company-facts"]')).toContainText('通过 IATF 16949 认证');
  await page.getByRole('checkbox', { name: '选择这条事实' }).check();
  await page.getByRole('button', { name: '通过所选' }).click();
  await expect(page.getByText('已通过 1 条事实。')).toBeVisible();
  expect(backend.callsTo('POST', '/claims/claim-1/approve')[0]?.body).toEqual({
    expectedVersion: 1,
  });
});

test('主链路 3：买家画像 → 方案生成/确认 → 开始寻源 → run 进度可见', async ({ page }) => {
  const backend = await installMockBackend(page);
  allowSourcing(backend, COMPANY.id);
  backend.set('GET', '/companies', [COMPANY]);
  backend.set('GET', '/icps', [ICP]);
  backend.set('GET', '/icps/icp-1', ICP);
  const plan = {
    createdAt: NOW,
    icpId: 'icp-1',
    id: 'plan-1',
    queries: [{ keywords: ['五金工具 进口商'], source_class: 'public_web' }],
    status: 'DRAFT',
    version: 1,
  };
  const plans: Array<typeof plan> = [];
  backend.set('GET', '/icps/icp-1/query-plans', json(() => plans));
  backend.set(
    'POST',
    '/icps/icp-1/query-plans',
    json(() => {
      if (!plans.length) plans.push(plan);
      return plan;
    }),
  );
  backend.set(
    'POST',
    '/query-plans/plan-1/confirm',
    json(() => {
      plan.status = 'READY';
      return plan;
    }),
  );
  backend.set('GET', '/tasks', []);
  backend.set('POST', '/tasks', {
    createdAt: NOW,
    createdBy: 'user-e2e',
    icpId: 'icp-1',
    id: 'task-1',
    lastRunAt: null,
    name: '德国五金进口商 · 挖掘任务',
    runs: [],
    status: 'active',
    updatedAt: NOW,
  });
  backend.set('POST', '/tasks/task-1/runs', { runId: 'run-1', status: 'RUNNING', taskRunId: 'tr-1' });
  backend.set('POST', '/runs', {});
  backend.set('GET', '/discovery-runs/run-1', {
    createdAt: NOW,
    id: 'run-1',
    icpId: 'icp-1',
    mode: 'quick',
    planId: 'plan-1',
    stats: {},
    status: 'RUNNING',
    taskRef: { taskId: 'task-1', taskRunId: 'tr-1' },
  });
  backend.set('GET', '/discovery-runs/run-1/jobs', [
    {
      companyId: 'c1',
      costCents: 0,
      country: 'DE',
      domain: 'muster-metallbau.de',
      finishedAt: null,
      id: 'job-1',
      lastErrorCode: null,
      name: 'Muster Metallbau GmbH',
      stage: 'quick_scan',
      startedAt: NOW,
      verdictDeep: null,
      verdictQuick: null,
    },
  ]);
  backend.set('GET', '/discovery-runs/run-1/events', { events: [], nextAfter: 0, status: 'RUNNING' });
  backend.set('GET', '/runs/run-1/trace', { data: [], page: { has_more: false } });

  await loginAs(page);
  await page.goto('/find-buyers');
  await page.getByRole('link', { name: '制定寻源方案', exact: true }).click();
  await page.getByRole('button', { name: '制定寻源方案', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '制定寻源方案', exact: true }).click();
  await page.getByRole('button', { name: '确认方案', exact: true }).click();
  await page.getByRole('button', { name: '开始寻源', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '开始寻源', exact: true }).click();

  await expect(page).toHaveURL(/\/runs\/run-1\?tab=progress$/);
  await expect(page.getByText('进行中').first()).toBeVisible();
  await page.getByText('技术详情与寻源过程', { exact: true }).click();
  await expect(page.getByText('Muster Metallbau GmbH')).toBeVisible();
});

/** 迭代画像后重新寻源的公共 mock：生效中的画像 + 一份带历史运行的任务 + 运行页。 */
function mockIteratedSourcing(
  backend: MockBackend,
  options: { plans: Array<Record<string, unknown>>; runs: Array<Record<string, unknown>> },
) {
  const icp = { ...ICP, version: 2 };
  backend.set('GET', '/companies', [COMPANY]);
  backend.set('GET', '/icps', [icp]);
  backend.set('GET', '/icps/icp-1', json(() => icp));
  backend.set('PATCH', '/icps/icp-1', json(() => {
    icp.version += 1;
    return icp;
  }));
  backend.set('GET', '/icps/icp-1/query-plans', json(() => options.plans));
  const draft = {
    createdAt: NOW,
    icpId: 'icp-1',
    id: 'plan-2',
    queries: [{ keywords: ['电动工具 经销商'], source_class: 'public_web' }],
    status: 'DRAFT',
    version: 1,
  };
  backend.set('POST', '/icps/icp-1/query-plans', json(() => {
    if (!options.plans.includes(draft)) options.plans.unshift(draft);
    return draft;
  }));
  backend.set('POST', '/query-plans/plan-2/confirm', json(() => {
    draft.status = 'READY';
    return draft;
  }));
  backend.set('GET', '/tasks', json(() => [{
    createdAt: NOW,
    createdBy: 'user-e2e',
    icpId: 'icp-1',
    id: 'task-1',
    lastRunAt: NOW,
    name: '德国五金进口商 · 挖掘任务',
    runs: options.runs,
    status: 'active',
    updatedAt: NOW,
  }]));
  backend.set('POST', '/tasks/task-1/runs', { runId: 'run-2', status: 'RUNNING', taskRunId: 'tr-2' });
  backend.set('POST', '/runs', {});
  backend.set('GET', '/discovery-runs/run-2', {
    createdAt: NOW,
    icpId: 'icp-1',
    id: 'run-2',
    mode: 'quick',
    planId: 'plan-1',
    stats: {},
    status: 'RUNNING',
    taskRef: { taskId: 'task-1', taskRunId: 'tr-2' },
  });
  backend.set('GET', '/discovery-runs/run-2/jobs', []);
  backend.set('GET', '/discovery-runs/run-2/events', { events: [], nextAfter: 0, status: 'RUNNING' });
  backend.set('GET', '/runs/run-2/trace', { data: [], page: { has_more: false } });
}

const EXECUTED_PLAN = {
  createdAt: NOW,
  icpId: 'icp-1',
  id: 'plan-1',
  queries: [{ keywords: ['五金工具 进口商'], source_class: 'public_web' }],
  status: 'EXECUTED',
  version: 2,
};
const FINISHED_RUN = {
  attempt: 1,
  finishedAt: NOW,
  id: 'tr-1',
  planId: 'plan-1',
  rerunOf: null,
  runId: 'run-1',
  startedAt: NOW,
  status: 'PARTIAL',
  trigger: 'manual',
};

test('主链路 3b：编辑画像后生成新方案，保留已执行版本和重新寻源入口', async ({ page }) => {
  const backend = await installMockBackend(page);
  allowSourcing(backend, COMPANY.id);
  mockIteratedSourcing(backend, { plans: [EXECUTED_PLAN], runs: [FINISHED_RUN] });

  await loginAs(page);
  await page.goto('/find-buyers');
  await page.getByRole('button', { name: '编辑画像', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '保存修改' }).click();
  await page.getByRole('tab', { name: '匹配条件' }).click();
  await page.getByText('画像版本与来源', { exact: true }).click();
  await expect(page.getByText('第 3 版')).toBeVisible();
  await page.getByRole('tab', { name: '概览', exact: true }).click();
  await page.getByRole('link', { name: '寻源方案', exact: true }).click();
  await expect(page).toHaveURL(/edited=1$/);
  await expect(page.getByText('画像已编辑。请核对旧方案的搜索范围，或按当前画像生成新版本。')).toBeVisible();
  await expect(page.getByRole('button', { name: '重新寻源', exact: true })).toBeEnabled();

  await page.getByRole('button', { name: '重新生成寻源方案', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '制定寻源方案', exact: true }).click();
  await expect(page).toHaveURL(/plan=plan-2$/);
  await page.getByRole('button', { name: '确认方案', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始寻源', exact: true })).toBeEnabled();

  await page.goto('/tasks?icp=icp-1&tab=plan&plan=plan-1');
  await page.getByRole('button', { name: '重新寻源', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '重新寻源', exact: true }).click();
  await page.waitForURL(/\/runs\/run-2/);
  const call = backend.take('POST', '/tasks/task-1/runs');
  expect(call?.body).toEqual({ attemptId: expect.stringMatching(/^[a-f0-9-]{36}$/), planId: 'plan-1' });
});

test('主链路 3c：上一轮寻源进行中，方案可编辑但无法重复发起', async ({ page }) => {
  const backend = await installMockBackend(page);
  allowSourcing(backend, COMPANY.id);
  mockIteratedSourcing(backend, { plans: [EXECUTED_PLAN], runs: [{ ...FINISHED_RUN, status: 'RUNNING', finishedAt: null }] });

  await loginAs(page);
  await page.goto('/tasks?icp=icp-1&tab=plan&plan=plan-1');
  await expect(page.getByRole('button', { name: '重新寻源', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '重新生成寻源方案', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '制定寻源方案', exact: true }).click();
  await page.getByRole('button', { name: '确认方案', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始寻源', exact: true })).toBeDisabled();
  expect(backend.callsTo('POST', '/tasks/task-1/runs')).toHaveLength(0);
});

test('主链路 4：线索接受 → 提升为商机', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/icps', [ICP]);
  backend.set('GET', '/icps/icp-1/lead-queues', {
    needs_review: 1,
    queueBasis: { fit_gate_preset: 0, human_accept: 0, human_reject: 0, score: 1 },
    recommended: 0,
    rejected: 0,
    sanctions_hold: 0,
    scored: true,
    suppressed: 0,
  });
  const lead: Record<string, unknown> = {
    canonicalCompanyId: 'c1',
    company: { country: 'DE', domain: 'muster-metallbau.de', name: 'Muster Metallbau GmbH' },
    createdAt: NOW,
    fitVerdict: 'match',
    icpId: 'icp-1',
    id: 'lead-1',
    queue: 'needs_review',
    scored: true,
    status: 'DISCOVERED',
    totalScore: 82,
    updatedAt: NOW,
  };
  backend.set('GET', '/leads', json(() => [lead]));
  backend.set(
    'POST',
    '/leads/lead-1/accept',
    json(() => {
      lead.status = 'QUALIFIED';
      lead.queue = 'recommended';
      return { accepted: true, eventId: 'evt-1' };
    }),
  );
  backend.set('GET', '/qgos', []);

  await loginAs(page);
  await page.goto('/leads');
  await page.locator('[data-gs="lead-review-pane"]').getByRole('heading', { name: 'Muster Metallbau GmbH' }).waitFor();
  await page.locator('[data-gs="lead-review-pane"] [data-gs="quick-drawer-accept"]').click();
  await page.getByRole('dialog').getByRole('button', { name: '确认跟进' }).click();
  await expect(page.getByText('已移入「值得跟进」')).toBeVisible();
  await page.getByRole('button', { name: '提升为商机' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('textarea').fill('已收到客户回复，约下周电话');
  await dialog.getByRole('button', { name: '提升为商机' }).click();
  await page.waitForURL(/\/opportunities/);
  const promote = backend.take('POST', '/qgos');
  expect(promote, '应提交商机提升').toBeTruthy();
  const body = promote!.body as { leadRef?: string; nextStep?: string };
  expect(body.leadRef).toBe('lead-1');
  expect(body.nextStep).toBe('已收到客户回复，约下周电话');
});

test('主链路 5：战役计划审批 → 已批准 → 运行期横幅（按授权执行）', async ({ page }) => {
  const backend = await installMockBackend(page);
  const detail = {
    authorizations: [],
    createdAt: NOW,
    id: 'camp-1',
    name: '德国五金 Q4 计划',
    objective: '在德国市场找到 30 家五金进口商',
    recentTrace: [],
    revisions: [
      {
        approvals: [
          {
            decidedAt: null,
            decidedBy: null,
            decisionReason: null,
            expiresAt: '2026-11-11T08:00:00.000Z',
            id: 'appr-1',
            requestedBy: 'user-e2e',
            state: 'PENDING',
          },
        ],
        audience: { icpIds: ['icp-1'], sizeCap: 30 },
        createdAt: NOW,
        id: 'rev-1',
        plan: {
          approvalPolicy: { required: true },
          audience: { icpIds: ['icp-1'], sizeCap: 30 },
          budget: { currency: 'USD' },
          decisionPolicy: { maxReplans: 0 },
          goal: { objective: '在德国市场找到 30 家五金进口商' },
          motions: [{ icpIds: ['icp-1'], type: 'discovery' }],
          schedule: {},
          schemaVersion: 'campaign-plan/v0',
        },
        planHash: 'sha256:abcdef0123456789',
        revisionNo: 1,
        state: 'SUBMITTED',
      },
    ],
    status: 'DRAFT',
    updatedAt: NOW,
  } as unknown as CampaignDetail;
  backend.set('GET', '/campaigns', [
    {
      createdAt: NOW,
      id: 'camp-1',
      latestRevision: { id: 'rev-1', planHash: 'sha256:abcdef', revisionNo: 1, state: 'SUBMITTED' },
      name: '德国五金 Q4 计划',
      objective: '在德国市场找到 30 家五金进口商',
      status: 'DRAFT',
      updatedAt: NOW,
    },
  ]);
  backend.set('GET', '/campaigns/camp-1', json(() => detail));
  backend.set('GET', '/icps', [ICP]);
  backend.set(
    'POST',
    '/campaigns/camp-1/approvals/appr-1/decide',
    json(() => {
      const revision = detail.revisions[0]!;
      revision.state = 'APPROVED';
      revision.approvals[0]!.state = 'APPROVED';
      revision.approvals[0]!.decidedBy = 'user-e2e';
      revision.approvals[0]!.decidedAt = NOW;
      return {};
    }),
  );

  await loginAs(page);
  await page.goto('/outreach?tab=campaigns');
  // QW17：末列按状态给动作（草稿 → 继续起草），整行也可点。
  await expect(page.getByRole('button', { name: '继续起草' })).toBeVisible();
  await page.getByRole('button', { name: '继续起草' }).first().click();
  await page.waitForURL(/\/outreach\/campaigns\/camp-1/);
  await settle(page);
  await expect(page.getByRole('heading', { name: '待审批' })).toBeVisible();
  await expect(page.getByText('批准后将签发执行授权并进入执行；发送仍受国家合规门与渠道授权约束。')).toBeVisible();
  await page.getByRole('button', { name: '批准' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: '批准' }).click();
  await expect(page.getByText('已批准，系统已签发执行授权。')).toBeVisible();
  // 批准即签发授权：页面不额外暴露手动“执行”入口
  await expect(page.getByRole('button', { name: /执行/ })).toHaveCount(0);
});

test('主链路 6：商机接受（SAO）→ 登记 Outcome', async ({ page }) => {
  const backend = await installMockBackend(page);
  const qgo: Record<string, unknown> = {
    campaignId: null,
    canonicalCompanyRef: 'c1',
    createdAt: NOW,
    createdBy: 'user-e2e',
    evidence: [{ support: '客户回复询问报价', type: 'customer_reply' }],
    icpRef: 'icp-1',
    id: 'qgo-1',
    leadRef: 'lead-1',
    nextStep: '下周电话确认采购清单',
    sao: null,
    score: 82,
    state: 'OPEN',
    title: 'Muster Metallbau GmbH',
    updatedAt: NOW,
  };
  backend.set('GET', '/qgos', json(() => [qgo]));
  backend.set('GET', '/qgos/qgo-1', json(() => qgo));
  backend.set(
    'POST',
    '/qgos/qgo-1/accept',
    json(() => {
      qgo.sao = { decidedAt: NOW, id: 'sao-1', reason: null, state: 'ACCEPTED' };
      return qgo;
    }),
  );
  backend.set(
    'POST',
    '/saos/sao-1/outcomes',
    json(() => {
      qgo.outcomes = [{ id: 'out-1', occurredAt: NOW, outcome: 'WON', source: 'MANUAL' }];
      return qgo.outcomes[0];
    }),
  );

  await loginAs(page);
  await page.goto('/opportunities');
  await page.getByText('Muster Metallbau GmbH').first().click();
  const drawer = page.locator('.ant-drawer');
  await page.getByRole('button', { name: '接受商机' }).click();
  // 接受后抽屉刷新为 SAO 已接受并出现结果登记表单（提示语会被随后的刷新清空，属既有行为）
  await expect(drawer.getByText('已接受 ·', { exact: false })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: '结果登记' })).toBeVisible();
  // antd-vue 4：combobox 是隐藏只读 search input，点选择器本体打开下拉
  await page.locator('.ant-drawer .ant-select-selector').first().click();
  // antd-vue 4 的下拉项不暴露 role=option，按列表项类名 + 文本定位
  await page.locator('.ant-select-item-option').filter({ hasText: '赢单' }).click();
  await drawer.getByRole('button', { name: '登记结果' }).click();
  await expect(drawer.locator('.qg__outcome-badge').first()).toHaveText('赢单');
  const outcome = backend.take('POST', '/saos/sao-1/outcomes');
  expect(outcome, '应提交结果登记').toBeTruthy();
  expect((outcome!.body as { outcome?: string }).outcome).toBe('WON');
});

test('主链路 7（展示侧）：禁联队列联动——对象不可裁决', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/icps', [ICP]);
  backend.set('GET', '/icps/icp-1/lead-queues', {
    needs_review: 0,
    queueBasis: { fit_gate_preset: 0, human_accept: 0, human_reject: 0, score: 0 },
    recommended: 0,
    rejected: 0,
    sanctions_hold: 0,
    scored: true,
    suppressed: 1,
  });
  backend.set('GET', '/leads', [
    {
      canonicalCompanyId: 'c2',
      company: { country: 'DE', name: 'Beispiel Handel AG' },
      createdAt: NOW,
      icpId: 'icp-1',
      id: 'lead-s1',
      queue: 'suppressed',
      scored: false,
      status: 'SUPPRESSED',
      updatedAt: NOW,
    },
  ]);

  await loginAs(page);
  await page.goto('/leads?queue=suppressed');
  await settle(page);
  await expect(page.getByText('禁联', { exact: true }).first()).toBeVisible();
  const pane = page.locator('[data-gs="lead-review-pane"]');
  await expect(pane.getByRole('heading', { name: 'Beispiel Handel AG' })).toBeVisible();
  await expect(pane.locator('[data-gs="quick-drawer-accept"], [data-gs="quick-drawer-reject"]')).toHaveCount(0);
});

test('主链路 8：触达批次草稿审批（发送通道关闭，页面无发送动作）', async ({ page }) => {
  const backend = await installMockBackend(page);
  const batch: Record<string, unknown> = {
    approvals: [
      {
        decidedAt: null,
        decidedBy: null,
        expiresAt: '2026-11-11T08:00:00.000Z',
        id: 'ap-1',
        state: 'PENDING',
      },
    ],
    createdAt: NOW,
    drafts: [
      {
        body: '您好，我们注意到贵司经营工业泵分销业务……',
        companyName: 'Muster Metallbau GmbH',
        contactRef: 'contact-1',
        id: 'draft-1',
        recipientEmail: 'einkauf@muster.de',
        status: 'DRAFT',
        subject: '关于工业泵供应的合作',
      },
    ],
    events: [{ createdAt: NOW, id: 'ev-1', type: 'BATCH_SUBMITTED' }],
    id: 'ob-1',
    name: '德国泵业首触',
    status: 'PENDING_APPROVAL',
  };
  backend.set('GET', '/outreach/batches', json(() => [
    { draftCount: 1, id: 'ob-1', name: '德国泵业首触', status: batch.status },
  ]));
  backend.set('GET', '/outreach/batches/ob-1', json(() => batch));
  backend.set(
    'POST',
    '/outreach/batches/ob-1/approvals/ap-1/decide',
    json((_: unknown) => {
      batch.status = 'APPROVED';
      (batch.approvals as Array<Record<string, unknown>>)[0]!.state = 'APPROVED';
      return batch;
    }),
  );

  await loginAs(page);
  await page.goto('/outreach?tab=batches');
  await settle(page);
  // 内嵌在「外发与战役」时不再渲染子页标题（F0），内容与「批准入队、发送受开关约束」语义仍需可见
  await expect(page.getByText('草稿先审后发；批准只进入待发队列，发送通道开放前不会发出任何邮件。')).toBeVisible();
  await expect(page.getByText('einkauf@muster.de')).toBeVisible();
  await expect(page.getByText('关于工业泵供应的合作')).toBeVisible();

  // 批准：只入待发队列；页面上没有任何“发送”动作
  await expect(page.getByRole('button', { name: /发送/ })).toHaveCount(0);
  await page.getByRole('button', { name: '批准', exact: true }).click();
  await expect(page.getByText('已批准，批次进入待发队列。')).toBeVisible();
  await expect(page.locator('.gs-badge', { hasText: '已批准' }).first()).toBeVisible();
  const decide = backend.take('POST', '/outreach/batches/ob-1/approvals/ap-1/decide');
  expect(decide, '应提交批准').toBeTruthy();
  expect((decide!.body as { decision?: string }).decision).toBe('approve');
  // 批准后也不出现发送入口（发送通道由服务端开关控制，v0 无发送代码）
  await expect(page.getByRole('button', { name: /发送/ })).toHaveCount(0);
});

test('主链路 9：设置 → 禁联名单增删与线索联动文案', async ({ page }) => {
  const backend = await installMockBackend(page);
  const rows: Array<Record<string, unknown>> = [];
  backend.set('GET', '/suppressions', json(() => ({ data: rows, page: { has_more: false } })));
  backend.set('POST', '/suppressions', (async ({ body, route }) => {
    const input = body as { reason?: string; type?: string; value?: string };
    const row = {
      createdAt: NOW,
      id: 'sup-1',
      protectionClass: 'LEGAL',
      reason: input.reason ?? null,
      type: input.type ?? 'email',
      value: input.value ?? '',
    };
    rows.unshift(row);
    await route.fulfill({ body: JSON.stringify({ data: row }), contentType: 'application/json', status: 200 });
    return true;
  }) as MockHandler);
  backend.set('DELETE', '/suppressions/sup-1', { decisionId: 'dec-1', deleted: false, releaseRequested: true });
  backend.set('GET', '/icps', [ICP]);
  backend.set('GET', '/icps/icp-1/lead-queues', {
    needs_review: 0,
    queueBasis: { fit_gate_preset: 0, human_accept: 0, human_reject: 0, score: 0 },
    recommended: 0,
    rejected: 0,
    sanctions_hold: 0,
    scored: true,
    suppressed: 1,
  });
  backend.set('GET', '/leads', [
    {
      canonicalCompanyId: 'c2',
      company: { country: 'DE', name: 'Beispiel Handel AG' },
      createdAt: NOW,
      icpId: 'icp-1',
      id: 'lead-s1',
      queue: 'suppressed',
      scored: false,
      status: 'SUPPRESSED',
      updatedAt: NOW,
    },
  ]);

  await loginAs(page);
  // 设置 → 禁联名单（Wave B3：底部「设置」直达整页 /settings/account，左侧子导航切至禁联名单）
  await page.locator('.sdr-footer__row', { hasText: '设置' }).click();
  await page.waitForURL((url) => url.pathname === '/settings/account');
  await page.locator('[data-gs="settings-nav-item"]', { hasText: '禁联名单' }).click();
  await page.waitForURL((url) => url.pathname === '/settings/suppressions');
  await expect(page.getByRole('heading', { name: '禁联名单', exact: true })).toBeVisible();
  await expect(page.locator('[data-gs="settings-shell"]').last()).toBeVisible();
  await expect(page.locator('.gs-settings__panel')).toHaveCount(0);
  await expect(page.getByText('名单还是空的')).toBeVisible();

  // 新增：邮箱 + 手动原因
  await page.getByPlaceholder('noreply@example.com').fill('noreply@example.com');
  await page.locator('.sp__form button').click();
  await expect(page.getByText('已加入禁联名单，立即生效。')).toBeVisible();
  await expect(page.getByText('noreply@example.com')).toBeVisible();
  const create = backend.take('POST', '/suppressions');
  expect(create, '应提交禁联登记').toBeTruthy();
  expect(create!.body).toMatchObject({ reason: 'manual', type: 'email', value: 'noreply@example.com' });

  // 解除申请：append-only，记录保留（不给“删除成功”假象）
  // 2026-11-23 方案 B：原生 confirm → antd 确认框（okText 与操作同名）
  await page.getByRole('button', { name: '解除申请' }).click();
  const confirmBox = page.locator('.ant-modal-confirm');
  await expect(confirmBox).toBeVisible();
  await confirmBox.getByRole('button', { name: '解除申请' }).click();
  await expect(confirmBox).toHaveCount(0);
  await expect(page.getByText('已提交解除申请：记录保留并进入复核流程（不会立即解除）。')).toBeVisible();
  await expect(page.getByText('noreply@example.com').first()).toBeVisible();
  await expect(page.locator('.gs-badge', { hasText: '法定' })).toBeVisible();

  // 联动文案：禁联对象出现在买家线索的「禁联」队列，且不可裁决
  await page.goto('/leads?queue=suppressed');
  await settle(page);
  await expect(page.getByText('禁联', { exact: true }).first()).toBeVisible();
  await expect(page.locator("[data-gs='lead-card'] [data-gs='lead-accept']")).toHaveCount(0);
});

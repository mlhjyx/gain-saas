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

test('主链路 1：注册 → 引导向导 → 完成建档', async ({ page }) => {
  const backend = await installMockBackend(page, { onboardingComplete: false });
  await page.goto('/auth/register');
  await page.locator('input[type="text"]').first().fill('E2E 测试公司');
  await page.locator('input[type="email"]').fill('e2e@gainos.local');
  await page.locator('input[type="password"]').fill('e2e-password-123');
  await page.locator('button.g-submit').click();

  // 注册 → 会话 → 引导未完成 → 强制进入向导
  await page.waitForURL(/\/onboarding/);
  await expect(page.getByRole('heading', { name: '完善企业档案' })).toBeVisible();
  await page.locator('input[placeholder*="https://"]').fill('https://example.org');

  await page.getByRole('button', { name: '下一步' }).click();
  await page.locator('.product-row input').fill('LED 灯具');
  // antd 会在两个汉字的按钮文本中插入空格（“添 加”），按行定位规避
  await page.locator('.product-row button').click();
  await page.getByRole('button', { name: '下一步' }).click();
  await page.locator('.onboarding-section .ant-select').click();
  await page.locator('.ant-select-item-option').first().click();
  await page.keyboard.press('Escape'); // 收起下拉，避免遮挡提交按钮
  await page.getByRole('button', { name: '完成建档' }).click();

  await page.waitForURL(/\/workspace/);
  const call = backend.take('POST', '/onboarding/company');
  expect(call, '应向 BFF 提交建档').toBeTruthy();
  const body = call!.body as { name?: string; products?: string[]; targetMarkets?: string[] };
  expect(body.name).toBe('E2E 测试公司');
  expect(body.products).toEqual(['LED 灯具']);
  expect(body.targetMarkets?.length).toBe(1);
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
  await page.getByRole('menuitem', { name: '公司档案' }).click();
  await page.waitForURL(/\/companies/);
  await page.getByRole('button', { name: '查看档案' }).click();
  await expect(page.getByText('通过 IATF 16949 认证')).toBeVisible();
  await page.getByRole('checkbox', { name: '选择这条事实' }).check();
  await page.getByRole('button', { name: '通过所选' }).click();
  await expect(page.getByText('已通过 1 条事实。')).toBeVisible();
});

test('主链路 3：目标客户画像 → 方案生成/确认 → 开始寻源 → run 进度可见', async ({ page }) => {
  const backend = await installMockBackend(page);
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
  await page.getByRole('button', { name: '查看与调整' }).click();
  await settle(page);
  await page.getByRole('button', { name: '生成寻源方案' }).click();
  await expect(page.getByRole('button', { name: '确认方案' })).toBeVisible();
  await page.getByRole('button', { name: '确认方案' }).click();
  await expect(page.getByRole('button', { name: '开始寻源' })).toBeVisible();
  await page.getByRole('button', { name: '开始寻源' }).click();

  await page.waitForURL(/\/runs\/run-1/);
  await expect(page.getByText('进行中').first()).toBeVisible();
  await expect(page.getByText('Muster Metallbau GmbH')).toBeVisible();
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
  const card = page.locator('.ld__lead').filter({ hasText: 'Muster Metallbau GmbH' });
  await card.getByRole('button', { name: '值得跟进' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认跟进' }).click();
  await expect(page.getByText('已移入「值得跟进」')).toBeVisible();
  await page.getByRole('button', { name: '提升为商机' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('textarea').fill('已收到客户回复，约下周电话');
  await dialog.getByRole('button', { name: '提升为商机' }).click();
  await page.waitForURL(/\/qgos/);
  const promote = backend.take('POST', '/qgos');
  expect(promote, '应提交商机提升').toBeTruthy();
  const body = promote!.body as { leadRef?: string; nextStep?: string };
  expect(body.leadRef).toBe('lead-1');
  expect(body.nextStep).toBe('已收到客户回复，约下周电话');
});

test('主链路 5：战役计划审批 → 已批准 → 影子横幅（不执行）', async ({ page }) => {
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
  await page.goto('/campaigns');
  await page.getByRole('button', { name: '查看' }).first().click();
  await page.waitForURL(/\/campaigns\/camp-1/);
  await settle(page);
  await expect(page.getByRole('heading', { name: '待审批' })).toBeVisible();
  await expect(page.locator('.cd__banner')).toHaveText('影子期：批准不会真的执行；我们只记录决策与指标。');
  await page.getByRole('button', { name: '批准' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: '批准' }).click();
  await expect(page.getByText('已批准，系统已签发执行授权（影子期不会真的执行）。')).toBeVisible();
  // 影子期没有任何“执行”动作入口
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
  await page.goto('/qgos');
  await page.getByText('Muster Metallbau GmbH').first().click();
  const drawer = page.locator('.qg__drawer');
  await page.getByRole('button', { name: '接受商机' }).click();
  // 接受后抽屉刷新为 SAO 已接受并出现结果登记表单（提示语会被随后的刷新清空，属既有行为）
  await expect(drawer.getByText('已接受 ·', { exact: false })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: '结果登记' })).toBeVisible();
  await drawer.locator('select').selectOption('WON');
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
  await expect(page.getByText('禁联').first()).toBeVisible();
  // 合规红线：禁联对象没有“值得跟进 / 暂不跟进”的可裁决按钮（队列页签不算）
  const cardButtons = page.locator('.ld__lead button');
  await expect(cardButtons.getByText('值得跟进')).toHaveCount(0);
  await expect(cardButtons.getByText('暂不跟进')).toHaveCount(0);
});

// 设计 §5 第 6 条（触达：草稿审批、发送开关关闭文案）与第 8 条增删侧依赖步 11 控制面页面；
// 步 11（m1-5 会话）上线后把 fixme 转成正式用例。
test.fixme('主链路（defer）：触达批次草稿审批与发送禁用', async () => {});
test.fixme('主链路（defer）：禁联名单增删（设置 → C2）', async () => {});

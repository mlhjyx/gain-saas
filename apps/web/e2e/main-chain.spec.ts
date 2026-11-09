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
  await page.goto('/campaigns');
  // QW17：末列按状态给动作（草稿 → 继续起草），整行也可点。
  await expect(page.getByRole('button', { name: '继续起草' })).toBeVisible();
  await page.getByRole('button', { name: '继续起草' }).first().click();
  await page.waitForURL(/\/campaigns\/camp-1/);
  await settle(page);
  await expect(page.getByRole('heading', { name: '待审批' })).toBeVisible();
  await expect(page.locator('.cd__banner')).toHaveText('批准后将签发执行授权并进入执行；发送仍受国家合规门与渠道授权约束。');
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
  await settle(page);
  await expect(page.getByText('禁联', { exact: true }).first()).toBeVisible();
  // 合规红线：禁联对象没有“值得跟进 / 暂不跟进”的可裁决按钮（队列页签不算）
  const cardButtons = page.locator('.ld__lead button');
  await expect(cardButtons.getByText('值得跟进')).toHaveCount(0);
  await expect(cardButtons.getByText('暂不跟进')).toHaveCount(0);
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
  await page.goto('/growth?tab=outreach');
  await settle(page);
  // 内嵌在「商机与触达」时不再渲染子页标题（F0），内容与「批准入队、发送受开关约束」语义仍需可见
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
  // 设置 → 禁联名单
  await page.locator('.vben-menu').getByText('设置', { exact: true }).click();
  await page.getByRole('menuitem', { name: '禁联名单' }).click();
  await page.waitForURL(/\/settings\/suppressions/);
  await expect(page.getByRole('heading', { name: '禁联名单', exact: true })).toBeVisible();
  await expect(page.getByText('名单还是空的')).toBeVisible();

  // 新增：邮箱 + 手动原因
  await page.locator('.sp__form input').fill('noreply@example.com');
  await page.locator('.sp__form button').click();
  await expect(page.getByText('已加入禁联名单，立即生效。')).toBeVisible();
  await expect(page.getByText('noreply@example.com')).toBeVisible();
  const create = backend.take('POST', '/suppressions');
  expect(create, '应提交禁联登记').toBeTruthy();
  expect(create!.body).toMatchObject({ reason: 'manual', type: 'email', value: 'noreply@example.com' });

  // 解除申请：append-only，记录保留（不给“删除成功”假象）
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '解除申请' }).click();
  await expect(page.getByText('已提交解除申请：记录保留并进入复核流程（不会立即解除）。')).toBeVisible();
  await expect(page.getByText('noreply@example.com')).toBeVisible();
  await expect(page.locator('.gs-badge', { hasText: '法定' })).toBeVisible();

  // 联动文案：禁联对象出现在买家线索的「禁联」队列，且不可裁决
  await page.goto('/leads?queue=suppressed');
  await settle(page);
  await expect(page.getByText('禁联', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.ld__lead button').getByText('值得跟进')).toHaveCount(0);
});

/**
 * Phase 1 获客全链路重构 E2E 回归测试：
 * 1. T0 四通道轻外联工作台（IT 放行 mailto、DE 禁用 mailto 引导领英/表单、BR 放行合规 wa.me、SUPPRESSED 全禁 + 触达留痕）
 * 2. 线索页 Battle CSV 导出按钮接线
 * 3. 触达批次页（route.query.lead 预选 + canonical 联系人与官方邮箱 + countryCode + 编辑保留 contactPointId）
 * 4. 注册建档（域名自动补齐 https:// + 有行业列表时解锁手动自定义行业）
 * 5. 买家画像页（原「找买家」：同公司多画像 + 一键确认建档事实 + DONE 后可重跑）
 */
import { expect, test } from '@playwright/test';

import { installMockBackend, loginAs } from './support/mock-backend';

const NOW = '2026-11-25T10:00:00.000Z';
const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const ICP_ID = '22222222-2222-4222-8222-222222222222';
const LEAD_IT = '33333333-3333-4333-8333-333333333333';
const LEAD_DE = '44444444-4444-4444-8444-444444444444';
const LEAD_BR = '55555555-5555-4555-8555-555555555555';
const LEAD_SUP = '66666666-6666-4666-8666-666666666666';
const CANON_IT = '77777777-7777-4777-8777-777777777777';
const CONTACT_IT = '88888888-8888-4888-8888-888888888888';
const POINT_IT = '99999999-9999-4999-8999-999999999999';
const BATCH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DRAFT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('T0 四通道轻外联：IT/DE/BR 合规分流、SUPPRESSED 全禁与触达留痕', async ({ page }) => {
  const backend = await installMockBackend(page);
  const touches: Array<Record<string, unknown>> = [];

  backend.set('GET', `/leads/${LEAD_IT}/package`, {
    lead_id: LEAD_IT,
    status: 'QUALIFIED',
    company: {
      canonical_company_id: CANON_IT,
      name: 'Refeel Solar S.r.l.',
      domain: 'refeel.it',
      country: 'IT',
    },
    company_channels: [
      { channel: 'email', value: 'acquisti@refeel.it', email_type: 'department', status: 'public' },
      { channel: 'phone', value: '+39 02 1234567', status: 'public' },
      { channel: 'form_url', value: 'https://refeel.it/contatti', status: 'public' },
    ],
    social_profiles: [{ platform: 'linkedin', url: 'https://www.linkedin.com/company/refeel' }],
    sanctions: { status: 'clear', screened_at: NOW },
  });
  backend.set('GET', `/canonical-companies/${CANON_IT}`, {
    company: {
      id: CANON_IT,
      name: 'Refeel Solar S.r.l.',
      country: 'IT',
      contacts: [
        {
          id: CONTACT_IT,
          fullName: 'Maria Rossi',
          title: 'Procurement Manager',
          contactPoints: [
            { id: POINT_IT, type: 'email', value: 'm.rossi@refeel.it', status: 'VALID' },
          ],
        },
      ],
    },
    evidence: [],
  });
  backend.set('GET', `/leads/${LEAD_DE}/package`, {
    lead_id: LEAD_DE,
    status: 'REVIEW',
    company: {
      canonical_company_id: 'c-de',
      name: 'Solaris GmbH',
      domain: 'solaris.de',
      country: 'DE',
    },
    company_channels: [
      { channel: 'email', value: 'einkauf@solaris.de', status: 'public' },
      { channel: 'form_url', value: 'https://solaris.de/kontakt', status: 'public' },
    ],
    sanctions: { status: 'clear', screened_at: NOW },
  });
  backend.set('GET', `/leads/${LEAD_BR}/package`, {
    lead_id: LEAD_BR,
    status: 'REVIEW',
    company: {
      canonical_company_id: 'c-br',
      name: 'Sol Brasil Ltda',
      domain: 'solbrasil.com.br',
      country: 'BR',
    },
    company_channels: [
      { channel: 'email', value: 'compras@solbrasil.com.br', status: 'public' },
      { channel: 'phone', value: '+55 11 98765-4321', status: 'public' },
    ],
    sanctions: { status: 'clear', screened_at: NOW },
  });
  backend.set('GET', `/leads/${LEAD_SUP}/package`, {
    lead_id: LEAD_SUP,
    status: 'SUPPRESSED',
    company: {
      canonical_company_id: 'c-sup',
      name: 'Blocked Energy S.r.l.',
      domain: 'blocked.it',
      country: 'IT',
    },
    company_channels: [
      { channel: 'email', value: 'info@blocked.it', status: 'public' },
      { channel: 'form_url', value: 'https://blocked.it/contact', status: 'public' },
    ],
    sanctions: { status: 'clear', screened_at: NOW },
  });
  backend.set('GET', '/outreach/t0/touches', async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify({ data: touches }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });
  backend.set('POST', '/outreach/t0/touches', async ({ body, route }) => {
    const payload = body as Record<string, unknown>;
    const created = {
      id: `touch-${touches.length + 1}`,
      leadId: payload.leadId,
      channel: payload.channel,
      targetMasked: 'm***@refeel.it',
      note: payload.note ?? null,
      outcome: payload.outcome ?? 'SENT',
      actorId: 'user-e2e',
      createdAt: NOW,
    };
    touches.unshift(created);
    await route.fulfill({
      body: JSON.stringify({ data: created }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });

  await loginAs(page);

  // 1. IT 线索：mailto + LinkedIn + form 可用，WhatsApp 禁发，记录轻触达落库
  await page.goto(`/leads/${LEAD_IT}`);
  await expect(page.locator('[data-gs="t0-outreach"]')).toBeVisible();
  await expect(page.locator('[data-gs="t0-action-mailto"]')).toBeEnabled();
  await expect(page.locator('[data-gs="t0-action-linkedin"]')).toBeEnabled();
  await expect(page.locator('[data-gs="t0-action-form"]')).toBeEnabled();
  await expect(page.locator('[data-gs="t0-action-whatsapp"]')).toBeDisabled();

  await page.locator('[data-gs="t0-touch-note"]').fill('已发首触邮件');
  await page.locator('[data-gs="t0-record-touch"]').click();
  await expect(page.locator('[data-gs="t0-touch-list"]')).toContainText('已发首触邮件');
  await expect(page.locator('[data-gs="t0-touch-list"]')).toContainText('m***@refeel.it');

  // 2. DE 线索：禁止 mailto 并引导领英/表单
  await page.goto(`/leads/${LEAD_DE}`);
  await expect(page.locator('[data-gs="t0-jurisdiction-banner"]')).toBeVisible();
  await expect(page.locator('[data-gs="t0-action-mailto"]')).toBeDisabled();
  await expect(page.locator('[data-gs="t0-action-linkedin"]')).toBeEnabled();
  await expect(page.locator('[data-gs="t0-action-form"]')).toBeEnabled();

  // 3. BR 线索：放行 mailto 与合规 wa.me
  await page.goto(`/leads/${LEAD_BR}`);
  await expect(page.locator('[data-gs="t0-action-mailto"]')).toBeEnabled();
  await expect(page.locator('[data-gs="t0-action-whatsapp"]')).toBeEnabled();

  // 4. SUPPRESSED 线索：全部 4 条触达动作禁用
  await page.goto(`/leads/${LEAD_SUP}`);
  await expect(page.locator('[data-gs="t0-blocked-banner"]')).toBeVisible();
  await expect(page.locator('[data-gs="t0-action-mailto"]')).toBeDisabled();
  await expect(page.locator('[data-gs="t0-action-linkedin"]')).toBeDisabled();
  await expect(page.locator('[data-gs="t0-action-whatsapp"]')).toBeDisabled();
  await expect(page.locator('[data-gs="t0-action-form"]')).toBeDisabled();
  await expect(page.locator('[data-gs="t0-record-touch"]')).toBeDisabled();

  // 5. 服务端门禁接口 500 故障：严格 fail-closed，锁死全部 4 条触达动作与留痕按钮
  backend.set('POST', '/outreach/t0/check', async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'DNC check failed' } }),
      contentType: 'application/json',
      status: 500,
    });
    return true;
  });
  await page.goto(`/leads/${LEAD_IT}`);
  await expect(page.locator('[data-gs="t0-blocked-banner"]')).toBeVisible();
  await expect(page.locator('[data-gs="t0-outreach"]')).toContainText('合规校验暂不可用');
  await expect(page.locator('[data-gs="t0-compliance-tag"]')).toHaveAttribute(
    'title',
    /DNC_UNAVAILABLE/,
  );
  await expect(page.locator('[data-gs="t0-action-mailto"]')).toBeDisabled();
  await expect(page.locator('[data-gs="t0-action-linkedin"]')).toBeDisabled();
  await expect(page.locator('[data-gs="t0-action-whatsapp"]')).toBeDisabled();
  await expect(page.locator('[data-gs="t0-action-form"]')).toBeDisabled();
  await expect(page.locator('[data-gs="t0-record-touch"]')).toBeDisabled();
});

test('线索页接入 Battle CSV 导出按钮并按队列透传 scope', async ({ page }) => {
  const backend = await installMockBackend(page);
  backend.set('GET', '/icps', [{ id: ICP_ID, companyId: COMPANY_ID, name: '意大利光伏', status: 'ACTIVE', targetMarkets: ['IT'], version: 1, personas: [], buyingCommittee: [], rules: [], ruleLint: [], createdAt: NOW }]);
  backend.set('GET', `/icps/${ICP_ID}/lead-queues`, {
    recommended: 1,
    needs_review: 1,
    rejected: 0,
    suppressed: 0,
    sanctions_hold: 0,
    scored: true,
    queueBasis: { fit_gate_preset: 0, score: 2, human_accept: 1, human_reject: 0 },
  });
  backend.set('GET', '/leads', [
    {
      id: LEAD_IT,
      icpId: ICP_ID,
      status: 'REVIEW',
      queue: 'needs_review',
      company: { name: 'Refeel Solar S.r.l.', country: 'IT', domain: 'refeel.it' },
      channelSummary: {
        emails: ['acquisti@refeel.it'],
        phones: ['+39 02 1234567'],
        forms: ['https://refeel.it/contatti'],
        socials: [],
        decisionMakerCount: 1,
        verifiedEmailCount: 1,
      },
    },
  ]);
  backend.set('GET', '/reports/battle-csv', async ({ route }) => {
    await route.fulfill({
      body: '\uFEFF公司,国家\nRefeel Solar S.r.l.,IT\n',
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="battle-card-test.csv"',
        'X-Report-Rows': '1',
      },
      status: 200,
    });
    return true;
  });

  await loginAs(page);
  await page.goto('/leads');
  const exportBtn = page.locator('[data-gs="export-battle-csv"]');
  await expect(exportBtn).toBeVisible();
  await exportBtn.click();

  await expect.poll(() => backend.callsTo('GET', '/reports/battle-csv').length).toBe(1);
  const csvCall = backend.callsTo('GET', '/reports/battle-csv')[0]!;
  expect(csvCall.query.icpId).toBe(ICP_ID);
  expect(csvCall.query.scope).toBe('reviewable');
});

test('触达批次页：支持 route.query.lead 预选、读取真实联系人/国家代码，编辑草稿保留 contactPointId', async ({ page }) => {
  const backend = await installMockBackend(page);
  const drafts: Array<Record<string, unknown>> = [];

  backend.set('GET', '/outreach/batches', async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify({
        data: [
          { id: BATCH_ID, name: '意大利首触', status: 'DRAFT', draftCount: drafts.length },
        ],
      }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });
  backend.set('GET', `/outreach/batches/${BATCH_ID}`, async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify({
        data: { id: BATCH_ID, name: '意大利首触', status: 'DRAFT', drafts, approvals: [], events: [] },
      }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });
  backend.set('GET', `/leads/${LEAD_IT}/package`, {
    lead_id: LEAD_IT,
    status: 'QUALIFIED',
    company: { canonical_company_id: CANON_IT, name: 'Refeel Solar S.r.l.', country: 'IT' },
    company_channels: [{ channel: 'email', value: 'info@refeel.it', status: 'public' }],
  });
  backend.set('GET', `/canonical-companies/${CANON_IT}`, {
    company: {
      id: CANON_IT,
      name: 'Refeel Solar S.r.l.',
      country: 'IT',
      contacts: [
        {
          id: CONTACT_IT,
          fullName: 'Maria Rossi',
          title: 'Head of Procurement',
          contactPoints: [{ id: POINT_IT, type: 'email', value: 'm.rossi@refeel.it', status: 'VALID' }],
        },
      ],
    },
    evidence: [],
  });
  backend.set('GET', `/leads/${LEAD_IT}/outreach-drafts`, {
    subject: 'HJT 700W Modules for Refeel',
    body: 'Hello Maria, happy to share our datasheet.',
  });
  backend.set('POST', `/outreach/batches/${BATCH_ID}/drafts`, async ({ body, route }) => {
    const payload = body as Record<string, unknown>;
    const row = { id: DRAFT_ID, batchId: BATCH_ID, status: 'DRAFT', ...payload };
    drafts.push(row);
    await route.fulfill({ body: JSON.stringify({ data: row }), contentType: 'application/json', status: 200 });
    return true;
  });
  backend.set('PATCH', `/outreach/batches/${BATCH_ID}/drafts/${DRAFT_ID}`, async ({ body, route }) => {
    const payload = body as Record<string, unknown>;
    Object.assign(drafts[0]!, payload);
    await route.fulfill({ body: JSON.stringify({ data: drafts[0] }), contentType: 'application/json', status: 200 });
    return true;
  });

  await loginAs(page);
  await page.goto(`/outreach?tab=batches&lead=${LEAD_IT}`);

  await expect(page.locator('[data-gs="preselected-lead-banner"]')).toBeVisible();
  await page.locator('[data-gs="apply-preselected-lead"]').click();
  await expect(page.locator('[data-gs="draft-email"]')).toHaveValue('m.rossi@refeel.it');
  await expect(page.locator('[data-gs="draft-country"]')).toHaveValue('IT');

  await page.getByRole('dialog').getByRole('button', { name: '保存' }).click();
  await expect.poll(() => backend.callsTo('POST', `/outreach/batches/${BATCH_ID}/drafts`).length).toBe(1);
  const addBody = backend.callsTo('POST', `/outreach/batches/${BATCH_ID}/drafts`)[0]!.body as Record<string, unknown>;
  expect(addBody).toMatchObject({
    contactRef: CONTACT_IT,
    contactPointId: POINT_IT,
    countryCode: 'IT',
    recipientEmail: 'm.rossi@refeel.it',
  });

  // 编辑主题时必须保留原 contactPointId 与 countryCode
  await page.locator('[data-gs="edit-draft"]').click();
  await page.locator('[data-gs="draft-subject"]').fill('Updated HJT Subject');
  await page.getByRole('dialog').getByRole('button', { name: '保存' }).click();
  await expect.poll(() => backend.callsTo('PATCH', `/outreach/batches/${BATCH_ID}/drafts/${DRAFT_ID}`).length).toBe(1);
  const patchBody = backend.callsTo('PATCH', `/outreach/batches/${BATCH_ID}/drafts/${DRAFT_ID}`)[0]!.body as Record<string, unknown>;
  expect(patchBody).toMatchObject({
    contactPointId: POINT_IT,
    countryCode: 'IT',
    subject: 'Updated HJT Subject',
  });
});

test('注册建档：自动补全 https:// 与解锁手动输入自定义行业', async ({ page }) => {
  const backend = await installMockBackend(page, { onboardingComplete: false });
  await loginAs(page);
  await page.waitForURL(/\/workspace$/);

  await page.getByPlaceholder('https://example.com 或 example.com').fill('solar-factory.example');
  await page.getByRole('button', { name: '开始后台分析' }).click();

  await expect.poll(() => backend.callsTo('POST', '/onboarding/preview').length).toBe(1);
  const previewCall = backend.callsTo('POST', '/onboarding/preview')[0]!.body as Record<string, unknown>;
  expect(previewCall.website).toBe('https://solar-factory.example');

  // 即使行业列表非空，也可切换到自定义行业输入
  await expect(page.locator('[data-gs="toggle-custom-industry"]')).toBeVisible();
  await page.locator('[data-gs="toggle-custom-industry"]').click();
  await page.locator('[data-gs="custom-industry-input"]').fill('异质结光伏组件制造');

  await page.getByRole('button', { name: '完成建档' }).click();
  await expect.poll(() => backend.callsTo('POST', '/onboarding/company').length).toBe(1);
  const completeBody = backend.callsTo('POST', '/onboarding/company')[0]!.body as Record<string, unknown>;
  expect(completeBody.industry).toBe('异质结光伏组件制造');
  expect(completeBody.industryCode).toBeUndefined();
});

test('买家画像：允许同公司新建第二组画像（带 attemptId）并支持一键确认建档事实', async ({ page }) => {
  const backend = await installMockBackend(page);
  let approvedClaims: Array<Record<string, unknown>> = [];

  backend.set('GET', '/companies', [
    { id: COMPANY_ID, name: 'E2E 光伏工厂', website: 'https://solar.example', targetMarkets: ['IT'] },
  ]);
  backend.set('GET', '/icps', [
    {
      id: ICP_ID,
      companyId: COMPANY_ID,
      name: '欧洲光伏 EPC',
      status: 'ACTIVE',
      companyAttributes: {},
      painPoints: [],
      triggerSignals: [],
      exclusions: [],
      valueProps: [],
      targetMarkets: ['DE'],
      version: 1,
      personas: [],
      buyingCommittee: [],
      rules: [],
      ruleLint: [],
      createdAt: NOW,
    },
  ]);
  backend.set('GET', `/companies/${COMPANY_ID}/claims`, async ({ route, url }) => {
    const status = url.searchParams.get('status');
    const data =
      status === 'APPROVED'
        ? approvedClaims
        : [{ id: 'claim-1', companyId: COMPANY_ID, type: 'capability', statement: 'HJT 700W', status: 'NEEDS_REVIEW', version: 1 }];
    await route.fulfill({ body: JSON.stringify({ data }), contentType: 'application/json', status: 200 });
    return true;
  });
  backend.set('POST', '/claims/claim-1/approve', async ({ route }) => {
    approvedClaims = [{ id: 'claim-1', companyId: COMPANY_ID, type: 'capability', statement: 'HJT 700W', status: 'APPROVED', version: 1 }];
    await route.fulfill({ body: JSON.stringify({ data: approvedClaims[0] }), contentType: 'application/json', status: 200 });
    return true;
  });
  backend.set('POST', `/companies/${COMPANY_ID}/icps`, {
    id: 'icp-2',
    companyId: COMPANY_ID,
    name: '意大利组件分销商',
    status: 'DRAFT',
    companyAttributes: {},
    painPoints: [],
    triggerSignals: [],
    exclusions: [],
    valueProps: [],
    targetMarkets: ['IT', 'ES'],
    version: 1,
    personas: [],
    buyingCommittee: [],
    rules: [],
    ruleLint: [],
    createdAt: NOW,
  });
  backend.set('GET', '/icps/icp-2', {
    id: 'icp-2',
    companyId: COMPANY_ID,
    name: '意大利组件分销商',
    status: 'DRAFT',
    companyAttributes: {},
    painPoints: [],
    triggerSignals: [],
    exclusions: [],
    valueProps: [],
    targetMarkets: ['IT', 'ES'],
    version: 1,
    personas: [],
    buyingCommittee: [],
    rules: [],
    ruleLint: [],
    createdAt: NOW,
  });

  await loginAs(page);
  await page.goto('/find-buyers');

  // 即使公司已有 1 组画像，点击「新建画像」依然弹出创建模态框
  await page.getByRole('button', { name: '新建画像' }).click();
  await expect(page.getByRole('dialog', { name: '设定买家画像' })).toBeVisible();

  // 无已通过事实时，点击一键确认建档事实解锁生成
  await page.locator('[data-gs="quick-approve-facts"]').click();
  await expect.poll(() => backend.callsTo('POST', '/claims/claim-1/approve').length).toBe(1);

  await page.locator('[data-gs="icp-create-markets"]').fill('IT, ES');
  await page.getByRole('dialog').getByRole('button', { name: '生成初稿' }).click();

  await expect.poll(() => backend.callsTo('POST', `/companies/${COMPANY_ID}/icps`).length).toBe(1);
  const createBody = backend.callsTo('POST', `/companies/${COMPANY_ID}/icps`)[0]!.body as Record<string, unknown>;
  expect(typeof createBody.attemptId).toBe('string');
  expect(createBody.confirmedTargetMarkets).toEqual(['IT', 'ES']);
});

test('买家画像：普通成员（非管理员）不显示一键审批事实按钮，提示联系管理员', async ({ page }) => {
  const backend = await installMockBackend(page, { role: 'member' });
  backend.set('GET', '/companies', [
    { id: COMPANY_ID, name: 'E2E 光伏工厂', website: 'https://solar.example', targetMarkets: ['IT'] },
  ]);
  backend.set('GET', '/icps', []);
  backend.set('GET', `/companies/${COMPANY_ID}/claims`, []);

  await loginAs(page);
  await page.goto('/find-buyers');

  await page.getByRole('button', { name: '新建画像' }).click();
  await expect(page.getByRole('dialog', { name: '设定买家画像' })).toBeVisible();
  await expect(page.locator('[data-gs="no-approved-facts-alert"]')).toContainText('联系工作空间管理员');
  await expect(page.locator('[data-gs="quick-approve-facts"]')).toHaveCount(0);
});

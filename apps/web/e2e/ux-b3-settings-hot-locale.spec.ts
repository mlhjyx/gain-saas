/**
 * Wave B3 专项 E2E（整页设置单轨 + /settings/account + Review Focus #7 + 精准修补 + 零刷新热切换）：
 * 1) 侧栏点「设置」与 /settings 重定向均直达整页 /settings/account，无 SettingsDialog 弹窗；
 * 2) Review Focus #7：输错旧密码返回 401 时停留在 /settings/account 展示中文错误且不踢回登录页；
 * 3) admin 内联改空间名 + 查看 usage-summary 与 wallet/summary + privacy 级联清理回执（无双分页/无裸 UUID）+ suppressions 决策历史抽屉；
 * 4) member 在 members.vue 看不到邀请/管理员操作且无 { $t( 裸文本；退出空间遇到 LAST_MEMBER/LAST_ADMIN 展示三段式白话文案；
 * 5) 4 环节零刷新中英热切换：未保存草稿与 window.__noReloadToken 完整保留（reloaded === false）。
 */
import type { MockHandler } from './support/mock-backend';

import { expect, test } from '@playwright/test';

import { errorPayload, installMockBackend, loginAs } from './support/mock-backend';

const SUP_1_ID = '11111111-1111-4111-8111-111111111111';
const SUP_2_ID = '22222222-2222-4222-8222-222222222222';
const DEC_1_ID = '33333333-3333-4333-8333-333333333333';
const DEC_2_ID = '44444444-4444-4444-8444-444444444444';
const MIRROR_1_ID = '55555555-5555-4555-8555-555555555555';
const MIRROR_2_ID = '66666666-6666-4666-8666-666666666666';
const REQ_1_ID = '77777777-7777-4777-8777-777777777777';
const REQ_2_ID = '88888888-8888-4888-8888-888888888888';

const NOW = '2026-11-26T10:00:00.000Z';

const BANNED_JARGON = [
  { id: 'run', re: /\bruns?\b|\brun[_A-Z]\w*/i },
  { id: 'icp', re: /\bICPs?\b|\bicp[_A-Z]\w*/i },
  { id: 'canonical', re: /\bcanonical\w*/i },
  { id: 'plan_hash', re: /plan[_-]?hash/i },
  { id: 'uuid', re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
  { id: 'enum', re: /\b(PARTIAL|FAILED|RISKY)\b/ },
];

function rawJson(make: (url: URL) => unknown, status = 200): MockHandler {
  return async ({ route, url }) => {
    await route.fulfill({
      body: JSON.stringify(make(url)),
      contentType: 'application/json',
      status,
    });
    return true;
  };
}

test('admin 全链路：整页设置导航、Review Focus #7 改密 401 不登出、改空间名、用量与钱包、回执与禁联决策历史', async ({
  page,
}) => {
  const backend = await installMockBackend(page, { displayName: '远航精密制造', role: 'admin' });

  let workspaceName = '远航精密制造';
  backend.set('GET', '/workspace/context', async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify({
        data: {
          allowedActions: ['workspace.rename', 'workspace.leave', 'members.manage', 'settings.manage'],
          onboarding: { companyId: null, complete: true },
          user: backend.session.user,
          workspace: { id: 'ws-e2e', name: workspaceName, role: 'admin' },
        },
      }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });

  backend.set('POST', '/auth/password', async ({ body, route }) => {
    const payload = body as { currentPassword?: string; newPassword?: string };
    if (payload.currentPassword === 'aaaaaaa111') {
      await route.fulfill({
        body: JSON.stringify({
          error: { code: 'AUTH_FAILED', message: '旧密码不正确' },
        }),
        contentType: 'application/json',
        status: 401,
      });
      return true;
    }
    await route.fulfill({
      body: JSON.stringify({ data: { ok: true } }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });

  backend.set('PATCH', '/workspaces/ws-e2e', async ({ body, route }) => {
    const payload = body as { name?: string };
    workspaceName = payload.name?.trim() || workspaceName;
    backend.session.workspaces[0]!.name = workspaceName;
    await route.fulfill({
      body: JSON.stringify({ data: { id: 'ws-e2e', name: workspaceName } }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });

  backend.set('GET', '/workspace/usage-summary', {
    canonicalCompanies: { total: 148 },
    canonicalContacts: { total: 62 },
    companies: { active: 1, draft: 0, enriching: 0, review: 1, total: 2 },
    discoveryRuns: { completed: 8, failed: 1, running: 0, total: 9 },
    icps: { active: 2, total: 3 },
    saas: {
      activeMembers: 4,
      alertLevel: 'warning',
      campaigns: 5,
      outreachSent30d: 36,
      qgos: 7,
      saos: 3,
      storageQuota: {
        isDefault: false,
        maxBytesPerWorkspace: '2147483648',
        maxDocumentsPerCompany: 200,
        maxDocumentsPerWorkspace: 500,
        maxExportsPerDay: 10,
      },
    },
    sellerDocuments: {
      quota: { maxBytesPerWorkspace: 2_147_483_648, maxPerCompany: 200, maxPerWorkspace: 500 },
      ready: 410,
      total: 420,
      totalBytes: 1_750_000_000,
    },
    workspaceId: 'ws-e2e',
  });

  backend.set('GET', '/wallet/summary', {
    account: {
      availableCredits: '1250',
      currency: 'CREDITS',
      heldCredits: '180',
      lifetimeSpent: '450',
      lifetimeToppedUp: '1500',
      status: 'ACTIVE',
      updatedAt: NOW,
      version: '3',
      workspaceId: 'ws-e2e',
    },
    activeHoldsCount: 1,
    billingEnabled: true,
    lotsSummary: {
      activeLotCount: 2,
      bonusCredits: '300',
      paidCredits: '950',
      soonestExpiryAt: '2026-12-31T23:59:59.000Z',
      totalActiveCredits: '1250',
    },
    priceCards: [],
  });

  backend.set('GET', '/deletion-mirrors', async ({ route, url }) => {
    const status = url.searchParams.get('status');
    const cursor = url.searchParams.get('cursor');
    if (cursor === 'm-cursor-1') {
      await route.fulfill({
        body: JSON.stringify({
          data: {
            hasMore: false,
            items: [
              {
                at: '2026-11-24T08:00:00.000Z',
                engineRequestId: REQ_2_ID,
                id: MIRROR_2_ID,
                saasDeleted: 2,
                status: 'FAILED',
              },
            ],
            nextCursor: null,
            total: 2,
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
      return true;
    }
    const allItems = [
      {
        at: '2026-11-26T09:00:00.000Z',
        engineRequestId: REQ_1_ID,
        id: MIRROR_1_ID,
        saasDeleted: 5,
        status: 'COMPLETED',
      },
    ];
    const items = status ? allItems.filter((item) => item.status === status) : allItems;
    await route.fulfill({
      body: JSON.stringify({
        data: {
          hasMore: !status,
          items,
          nextCursor: status ? null : 'm-cursor-1',
          total: status ? items.length : 2,
        },
      }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });

  backend.set('GET', '/suppressions', {
    data: [
      {
        createdAt: NOW,
        id: SUP_1_ID,
        protectionClass: 'LEGAL',
        reason: 'legal',
        type: 'email',
        value: 'gdpr@buyer.de',
      },
      {
        createdAt: NOW,
        id: SUP_2_ID,
        protectionClass: 'PREFERENCE',
        reason: 'manual',
        type: 'domain',
        value: 'nocontact.example',
      },
    ],
    page: { has_more: false, next_cursor: null },
  });

  backend.set(
    'GET',
    `/suppressions/${SUP_1_ID}/decisions`,
    rawJson(() => ({
      data: [
        {
          actorId: '99999999-9999-4999-8999-999999999999',
          createdAt: '2026-11-25T11:30:00.000Z',
          decision: 'RELEASE_REQUEST_DENIED',
          id: DEC_1_ID,
          reasonCode: 'LEGAL_SUPPRESSION_PROTECTED',
          requestedDecision: 'RELEASE_REQUESTED',
          requestedReasonCode: 'PREFERENCE_RELEASE',
          suppressionId: SUP_1_ID,
        },
        {
          actorId: '99999999-9999-4999-8999-999999999999',
          createdAt: '2026-11-26T09:15:00.000Z',
          decision: 'IDENTITY_CORRECTION_REQUESTED',
          id: DEC_2_ID,
          reasonCode: 'IDENTITY_MISMATCH',
          requestedDecision: 'IDENTITY_CORRECTION_REQUESTED',
          requestedReasonCode: 'IDENTITY_MISMATCH',
          suppressionId: SUP_1_ID,
        },
      ],
      page: { has_more: false, next_cursor: null },
    })),
  );
  backend.set(
    'GET',
    `/suppressions/${SUP_2_ID}/decisions`,
    rawJson(() => ({
      data: [],
      page: { has_more: false, next_cursor: null },
    })),
  );

  await loginAs(page);

  // 1) 侧栏底部「设置」直达整页 /settings/account，且无 SettingsDialog 弹窗
  await page.locator('.sdr-footer__row', { hasText: '设置' }).click();
  await page.waitForURL((url) => url.pathname === '/settings/account');
  await expect(page.locator('.gs-settings__panel')).toHaveCount(0);
  await expect(page.locator('[data-gs="settings-shell"]')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: '账号与空间' })).toBeVisible();

  // admin 可见全部 7 个子页入口（含发信邮箱）
  const nav = page.locator('[data-gs="settings-subnav"]');
  for (const label of [
    '账号与空间',
    '成员与角色',
    '禁联名单',
    '数据来源',
    '隐私与数据',
    '审计日志',
    '发信邮箱',
  ]) {
    await expect(nav.locator('[data-gs="settings-nav-item"]', { hasText: label })).toBeVisible();
  }

  // /settings 自动重定向至 /settings/account
  await page.goto('/settings');
  await page.waitForURL((url) => url.pathname === '/settings/account');

  // 2) Review Focus #7：输错旧密码返回 401，停留在 /settings/account 原地报错、不跳登录页
  await page.locator('[data-gs="account-current-password"] input').fill('aaaaaaa111');
  await page.locator('[data-gs="account-new-password"] input').fill('bbbbbbb222');
  await page.locator('[data-gs="account-confirm-password"] input').fill('bbbbbbb222');
  await page.locator('[data-gs="account-password-submit"]').click();

  await expect(page.locator('[data-gs="account-password-error"]')).toBeVisible();
  await expect(page.locator('[data-gs="account-password-error"]')).toContainText('当前密码不正确');
  await page.waitForTimeout(400);
  expect(new URL(page.url()).pathname).toBe('/settings/account');
  await expect(page.locator('input[type="email"]')).toHaveCount(0);

  // 输入正确旧密码后改密成功且保持登录态
  await page.locator('[data-gs="account-current-password"] input').fill('ccccccc333');
  await page.locator('[data-gs="account-password-submit"]').click();
  await expect(page.locator('[data-gs="account-password-success"]')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/settings/account');

  // 3) 管理员内联修改空间名 + 用量全景 + 钱包摘要
  await page.locator('[data-gs="workspace-rename-edit"]').click();
  await page.locator('[data-gs="workspace-rename-input"]').fill('远航智能科技');
  await page.locator('[data-gs="workspace-rename-save"]').click();
  await expect(page.locator('[data-gs="workspace-rename-success"]')).toBeVisible();
  await expect(page.locator('[data-gs="account-workspace-name"]')).toHaveText('远航智能科技');
  await expect(page.locator('.sdr-account__name')).toHaveText('远航智能科技');

  await expect(page.locator('[data-gs="account-usage-alert-tag"]')).toContainText('接近上限');
  await expect(page.locator('[data-gs="account-usage-docs"]')).toContainText('420 / 500');
  await expect(page.locator('[data-gs="usage-stat-buyers"]')).toContainText('148');
  await expect(page.locator('[data-gs="account-wallet-available"]')).toContainText('1,250');

  // 零术语与零裸 UUID 检查（/settings/account）
  const accountText = await page.locator('body').innerText();
  for (const pattern of BANNED_JARGON) {
    expect(accountText, `/settings/account 不得出现禁用词 ${pattern.id}`).not.toMatch(pattern.re);
  }

  // 4) 切到 /settings/privacy：验证级联清理回执（状态筛选、加载更多、无裸 UUID、DSR 无双分页）
  await nav.locator('[data-gs="settings-nav-item"]', { hasText: '隐私与数据' }).click();
  await page.waitForURL((url) => url.pathname === '/settings/privacy');

  const mirrorsCard = page.locator('[data-gs="deletion-mirrors-card"]');
  await expect(mirrorsCard).toBeVisible();
  await expect(mirrorsCard).toContainText('清理完成');
  await expect(mirrorsCard).toContainText('清理 5 条');
  await expect(mirrorsCard.locator('.ant-pagination')).toHaveCount(0);
  await expect(page.locator('[data-gs="privacy-requests-card"] .ant-pagination')).toHaveCount(0);

  await page.locator('[data-gs="deletion-mirrors-load-more"]').click();
  await expect(mirrorsCard).toContainText('未完成');
  await expect(mirrorsCard).toContainText('清理 2 条');

  await page.locator('[data-gs="deletion-mirrors-status-filter"] .ant-select-selector').click();
  await page.locator('.ant-select-item-option', { hasText: '清理完成' }).click();
  await expect
    .poll(() =>
      backend
        .callsTo('GET', '/deletion-mirrors')
        .some((call) => call.query.status === 'COMPLETED'),
    )
    .toBe(true);

  const privacyText = await page.locator('body').innerText();
  expect(privacyText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  expect(privacyText).not.toMatch(/\b(PARTIAL|FAILED|RISKY)\b/);

  // 5) 切到 /settings/suppressions：查看禁联审批决策历史（含非空与空态，零英文机器码与裸 UUID）
  await page
    .locator('[data-gs="settings-subnav"]')
    .last()
    .locator('[data-gs="settings-nav-item"]', { hasText: '禁联名单' })
    .click();
  await page.waitForURL((url) => url.pathname === '/settings/suppressions');

  await page.locator('[data-gs="suppression-decisions-btn"]').first().click();
  const drawer = page.locator('[data-gs="suppression-decisions-drawer"]');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('已拒绝解除（法定保护）');
  await expect(drawer).toContainText('受法定合规保护，不可解除');
  await expect(drawer).toContainText('已登记主体更正');
  const drawerText = await drawer.innerText();
  expect(drawerText).not.toContain('RELEASE_REQUEST_DENIED');
  expect(drawerText).not.toContain('LEGAL_SUPPRESSION_PROTECTED');
  expect(drawerText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);

  // 空态验证
  await page.locator('[data-gs="suppression-decisions-btn"]').nth(1).click();
  await expect(page.locator('[data-gs="suppression-decisions-empty"]')).toBeVisible();
});

test('member 角色边界：成员页隐藏管理员操作且修复加载文案花括号、退出空间展示三段式错误、子导航仅见 2 项', async ({
  page,
}) => {
  const backend = await installMockBackend(page, { displayName: '协同贸易公司', role: 'member' });

  let releaseMembers!: () => void;
  const membersGate = new Promise<void>((resolvePromise) => {
    releaseMembers = resolvePromise;
  });

  backend.set('GET', '/members', async ({ route }) => {
    await membersGate;
    await route.fulfill({
      body: JSON.stringify({
        data: {
          invitations: [],
          members: [
            { email: 'admin@gainos.local', id: 'm-1', joinedAt: NOW, role: 'admin' },
            { email: 'e2e@gainos.local', id: 'm-2', joinedAt: NOW, role: 'member' },
          ],
        },
      }),
      contentType: 'application/json',
      status: 200,
    });
    return true;
  });

  backend.set('POST', '/workspaces/ws-e2e/leave', async ({ route }) => {
    await route.fulfill({
      body: JSON.stringify(
        errorPayload('LAST_MEMBER', {
          next: '请先邀请其他同事加入并移交管理权限后再退出，或在设置中申请注销该工作空间。',
          title: '你是最后一名成员，暂时不能退出',
          why: '每个工作空间至少需要保留一名成员，避免空间无人维护。',
        }),
      ),
      contentType: 'application/json',
      status: 400,
    });
    return true;
  });

  await loginAs(page);

  // 1) /settings/members：加载中无 { $t( 裸文本；成员只读、无邀请/改角色/移除按钮
  await page.goto('/settings/members');
  const srLoading = page.locator('.mb__state-sr');
  await expect(srLoading).toBeAttached();
  await expect(srLoading).not.toContainText('{ $t(');
  await expect(srLoading).toHaveText('正在加载…');
  releaseMembers();

  await expect(page.getByText('admin@gainos.local')).toBeVisible();
  await expect(page.locator('[data-gs="members-readonly-hint"]')).toBeVisible();
  await expect(page.locator('[data-gs="members-invite-btn"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '邀请成员' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '移除' })).toHaveCount(0);

  // 子导航仅显示 2 项（账号与空间、成员与角色），不展示管理员专属分组
  const navItems = page.locator('[data-gs="settings-subnav"] [data-gs="settings-nav-item"]');
  await expect(navItems).toHaveCount(2);
  await expect(navItems.nth(0)).toContainText('账号与空间');
  await expect(navItems.nth(1)).toContainText('成员与角色');

  // 2) /settings/account：无编辑空间名按钮；点退出走 AntDV danger 确认框，触发 LAST_MEMBER 三段式友好提示
  await navItems.nth(0).click();
  await page.waitForURL((url) => url.pathname === '/settings/account');

  await expect(page.locator('[data-gs="workspace-rename-edit"]')).toHaveCount(0);
  await expect(page.locator('[data-gs="workspace-rename-readonly"]')).toBeVisible();

  let nativeDialogTriggered = false;
  page.on('dialog', () => {
    nativeDialogTriggered = true;
  });

  await page.locator('[data-gs="account-leave-btn"]').click();
  const confirmModal = page.locator('.ant-modal-confirm');
  await expect(confirmModal).toBeVisible();
  await confirmModal.locator('.ant-btn-dangerous').click();
  await expect(confirmModal).toHaveCount(0);
  expect(nativeDialogTriggered).toBe(false);

  const leaveError = page.locator('[data-gs="account-leave-error"]');
  await expect(leaveError).toBeVisible();
  await expect(leaveError).toContainText('你是最后一名成员，暂时不能退出');
  await expect(leaveError).toContainText('每个工作空间至少需要保留一名成员');
  await expect(leaveError).toContainText('请先邀请其他同事加入');
});

test('4 环节零刷新双语热切换：未保存草稿与 window.__noReloadToken 完好保留（reloaded === false）', async ({
  page,
}) => {
  await installMockBackend(page, { displayName: '热切测试企业', role: 'admin' });
  await loginAs(page);

  await page.goto('/settings/account');
  await expect(page.getByRole('heading', { level: 1, name: '账号与空间' })).toBeVisible();
  await expect(page.locator('[data-sdr-nav] .sdr-section__label').first()).toHaveText('总览');
  await expect(
    page.locator('[data-sdr-nav]').getByRole('menuitem', { name: '买家画像' }),
  ).toBeVisible();

  // 写入未保存草稿 + window 令牌
  await page.locator('[data-gs="workspace-rename-edit"]').click();
  const draftInput = page.locator('[data-gs="workspace-rename-input"]');
  await draftInput.fill('未保存草稿-Draft-2026');
  await page.evaluate(() => {
    (window as unknown as { __noReloadToken?: string }).__noReloadToken = 'keep-alive-b3';
  });

  // 切换到 English（零刷新）
  await page.getByRole('button', { name: '切换到 English' }).click();

  await expect(page.locator('.sdr-brandtools__lang')).toHaveText('EN');
  await expect(page.getByRole('heading', { level: 1, name: 'Account & workspace' })).toBeVisible();
  await expect(page.locator('[data-sdr-nav] .sdr-section__label').first()).toHaveText('Overview');
  await expect(
    page.locator('[data-sdr-nav]').getByRole('menuitem', { name: 'Buyer profiles' }),
  ).toBeVisible();
  await expect(
    page.locator('[data-gs="settings-subnav"] [data-gs="settings-nav-item"]').first(),
  ).toContainText('Account & workspace');
  await expect(page.locator('[data-tab-item].is-active')).toContainText('Account & workspace');

  // 确认未重载且草稿完好无损
  const reloadedToEn = await page.evaluate(
    () => (window as unknown as { __noReloadToken?: string }).__noReloadToken !== 'keep-alive-b3',
  );
  expect(reloadedToEn, '切英文不得整页重载').toBe(false);
  await expect(draftInput).toHaveValue('未保存草稿-Draft-2026');

  // 切回中文同样零刷新且保留草稿
  await page.getByRole('button', { name: 'Switch to Chinese' }).click();
  await expect(page.locator('.sdr-brandtools__lang')).toHaveText('中');
  await expect(page.getByRole('heading', { level: 1, name: '账号与空间' })).toBeVisible();
  await expect(page.locator('[data-sdr-nav] .sdr-section__label').first()).toHaveText('总览');
  await expect(
    page.locator('[data-sdr-nav]').getByRole('menuitem', { name: '买家画像' }),
  ).toBeVisible();

  const reloadedToZh = await page.evaluate(
    () => (window as unknown as { __noReloadToken?: string }).__noReloadToken !== 'keep-alive-b3',
  );
  expect(reloadedToZh, '切回中文不得整页重载').toBe(false);
  await expect(draftInput).toHaveValue('未保存草稿-Draft-2026');
});

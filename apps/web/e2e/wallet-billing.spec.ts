/**
 * M9-PR1 充值钱包 W1 独立 E2E（spec 内自包含 page.route mock，不依赖也不改动 mock-backend.ts）：
 * 1. /settings/privacy 中挂载的租户钱包总览、透明价目表、批次明细、流水筛选与翻页，零裸 UUID
 * 2. /ops「积分钱包」运营面板：手动充值、发放赠点、发布价目表、过期预占巡检与毛利对账
 */
import type { Page, Route } from '@playwright/test';

import { expect, test } from '@playwright/test';

const LOT_BONUS_ID = '11111111-bbbb-4bbb-8bbb-111111111111';
const LOT_PAID_ID = '22222222-bbbb-4bbb-8bbb-222222222222';
const LEDGER_1_ID = '33333333-bbbb-4bbb-8bbb-333333333333';
const LEDGER_2_ID = '44444444-bbbb-4bbb-8bbb-444444444444';
const LEDGER_PAGE2_ID = '55555555-bbbb-4bbb-8bbb-555555555555';
const OPS_WS_ID = '66666666-bbbb-4bbb-8bbb-666666666666';
const CARD_1_ID = '77777777-bbbb-4bbb-8bbb-777777777777';
const CARD_2_ID = '88888888-bbbb-4bbb-8bbb-888888888888';

interface ApiCall {
  body: unknown;
  method: string;
  path: string;
  query: Record<string, string>;
}

async function installSelfContainedApiMock(
  page: Page,
  handlers: Record<
    string,
    (ctx: { body: unknown; route: Route; url: URL }) => Promise<void> | void
  >,
): Promise<{ calls: ApiCall[] }> {
  const calls: ApiCall[] = [];
  let signedIn = false;
  const session = {
    user: { email: 'wallet-e2e@gainos.local', id: 'user-e2e' },
    workspace: { id: 'ws-e2e', role: 'admin' },
    workspaces: [{ id: 'ws-e2e', name: '钱包测试企业', role: 'admin' }],
  };

  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const defaultOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT || 4173}`;
    if (url.origin !== (process.env.PLAYWRIGHT_BASE_URL ?? defaultOrigin)) {
      await route.continue();
      return;
    }
    if (req.isNavigationRequest() && req.resourceType() === 'document') {
      await route.continue();
      return;
    }
    // 兼容本地（VITE_GLOB_API_URL=/api）与 CI（无 /api 前缀）两套静态构建产物。
    const path = url.pathname.startsWith('/api/') ? url.pathname.slice(4) : url.pathname;
    const method = req.method().toUpperCase();
    if (
      method === 'GET' &&
      (path === '/' ||
        path.startsWith('/assets/') ||
        /\.(?:css|ico|js|json|map|png|svg|woff2?)$/.test(path))
    ) {
      await route.continue();
      return;
    }
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = req.postData();
    }
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      query[k] = v;
    });
    calls.push({ body, method, path, query });

    const exact = handlers[`${method} ${path}`];
    if (exact) {
      await exact({ body, route, url });
      return;
    }

    const json = (payload: unknown, status = 200) =>
      route.fulfill({
        body: JSON.stringify(payload),
        contentType: 'application/json',
        status,
      });

    if (method === 'POST' && path === '/auth/login') {
      signedIn = true;
      await json({ data: session });
      return;
    }
    if (method === 'GET' && path === '/auth/registration-policy') {
      await json({ data: { inviteCodeRequired: false } });
      return;
    }
    if (method === 'GET' && path === '/auth/session') {
      if (!signedIn) {
        await json({ error: { code: 'UNAUTHORIZED', message: '未登录' } }, 401);
        return;
      }
      await json({ data: session });
      return;
    }
    if (method === 'GET' && path === '/onboarding/status') {
      await json({ data: { complete: true } });
      return;
    }
    if (method === 'GET' && path === '/workspace/context') {
      await json({
        data: {
          allowedActions: [],
          onboarding: { companyId: null, complete: true },
          user: session.user,
          workspace: { id: 'ws-e2e', name: '钱包测试企业', role: 'admin' },
        },
      });
      return;
    }
    if (method === 'GET' && (path === '/canonical-companies' || path === '/deletion-requests' || path === '/data-exports')) {
      await json({ data: [], page: { has_more: false, next_cursor: null } });
      return;
    }
    if (method === 'GET' && path === '/notifications') {
      await json({ data: { items: [], unreadCount: 0 } });
      return;
    }
    if (method === 'GET' && path === '/workspaces') {
      await json({ data: session.workspaces });
      return;
    }
    await json({ data: method === 'GET' ? [] : {} });
  });

  return { calls };
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForURL(/\/auth\/login/);
  await page.locator('input[type="email"]').fill('wallet-e2e@gainos.local');
  await page.locator('input[type="password"]').fill('e2e-password-123');
  await page.locator('button.g-submit').click();
  await page.waitForURL(/\/workspace|\/onboarding/);
}

test('设置 → 数据与隐私页集成积分钱包：余额总览、价目表、批次明细、流水筛选与翻页，零裸 UUID', async ({ page }) => {
  const ledgerPage1 = [
    {
      actionCode: 'DISCOVERY_QUALIFIED_LEAD',
      balanceAvailable: '1250',
      balanceHeld: '0',
      billableUnits: 15,
      createdAt: '2026-11-26T09:30:00.000Z',
      deltaAvailable: '0',
      deltaHeld: '-150',
      entryType: 'SETTLE',
      holdId: null,
      id: LEDGER_1_ID,
      idempotencyKey: 'settle:1',
      lotId: LOT_BONUS_ID,
      refId: null,
      refType: 'discovery_run',
      workspaceId: 'ws-e2e',
    },
    {
      actionCode: null,
      balanceAvailable: '1500',
      balanceHeld: '0',
      billableUnits: null,
      createdAt: '2026-11-24T08:00:00.000Z',
      deltaAvailable: '1500',
      deltaHeld: '0',
      entryType: 'TOPUP',
      holdId: null,
      id: LEDGER_2_ID,
      idempotencyKey: 'topup:ord-01',
      lotId: LOT_PAID_ID,
      refId: 'ord-01',
      refType: 'order',
      workspaceId: 'ws-e2e',
    },
  ];
  const ledgerPage2 = [
    {
      actionCode: 'CONTACT_VALID_EMAIL',
      balanceAvailable: '1250',
      balanceHeld: '0',
      billableUnits: 0,
      createdAt: '2026-11-23T08:00:00.000Z',
      deltaAvailable: '2',
      deltaHeld: '-2',
      entryType: 'RELEASE',
      holdId: null,
      id: LEDGER_PAGE2_ID,
      idempotencyKey: 'release:1',
      lotId: null,
      refId: null,
      refType: 'contact_verify',
      workspaceId: 'ws-e2e',
    },
  ];

  const { calls } = await installSelfContainedApiMock(page, {
    'GET /wallet/summary': async ({ route }) => {
      await route.fulfill({
        body: JSON.stringify({
          data: {
            account: {
              availableCredits: '1250',
              currency: 'CREDITS',
              heldCredits: '200',
              lifetimeSpent: '450',
              lifetimeToppedUp: '1500',
              status: 'ACTIVE',
              updatedAt: '2026-11-26T10:00:00.000Z',
              version: '5',
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
            priceCards: [
              {
                actionCode: 'DISCOVERY_QUALIFIED_LEAD',
                active: true,
                createdAt: '2026-11-26T00:00:00.000Z',
                creditsPerUnit: '10',
                defaultHoldUnits: 20,
                displayName: '有效买家线索',
                effectiveFrom: '2026-11-26T00:00:00.000Z',
                effectiveTo: null,
                id: CARD_1_ID,
                pricingMode: 'PER_UNIT_OUTCOME',
                updatedAt: '2026-11-26T00:00:00.000Z',
              },
              {
                actionCode: 'CONTACT_VALID_EMAIL',
                active: true,
                createdAt: '2026-11-26T00:00:00.000Z',
                creditsPerUnit: '2',
                defaultHoldUnits: 1,
                displayName: '验真有效邮箱',
                effectiveFrom: '2026-11-26T00:00:00.000Z',
                effectiveTo: null,
                id: CARD_2_ID,
                pricingMode: 'PER_UNIT_OUTCOME',
                updatedAt: '2026-11-26T00:00:00.000Z',
              },
            ],
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    },
    'GET /wallet/lots': async ({ route }) => {
      await route.fulfill({
        body: JSON.stringify({
          data: [
            {
              createdAt: '2026-11-25T08:00:00.000Z',
              expiresAt: '2026-12-31T23:59:59.000Z',
              id: LOT_BONUS_ID,
              initialCredits: '500',
              priority: 1,
              remainingCredits: '300',
              sourceType: 'PROMO_BONUS',
              workspaceId: 'ws-e2e',
            },
            {
              createdAt: '2026-11-24T08:00:00.000Z',
              expiresAt: null,
              id: LOT_PAID_ID,
              initialCredits: '1500',
              priority: 10,
              remainingCredits: '950',
              sourceType: 'TOPUP_PAID',
              workspaceId: 'ws-e2e',
            },
          ],
        }),
        contentType: 'application/json',
        status: 200,
      });
    },
    'GET /wallet/ledger': async ({ route, url }) => {
      const entryType = url.searchParams.get('entryType');
      const cursor = url.searchParams.get('cursor');
      const payload =
        cursor === LEDGER_2_ID
          ? { data: ledgerPage2, page: { has_more: false, next_cursor: null } }
          : {
              data: entryType ? ledgerPage1.filter((r) => r.entryType === entryType) : ledgerPage1,
              page: entryType
                ? { has_more: false, next_cursor: null }
                : { has_more: true, next_cursor: LEDGER_2_ID },
            };
      await route.fulfill({
        body: JSON.stringify(payload),
        contentType: 'application/json',
        status: 200,
      });
    },
  });

  await signIn(page);
  await page.goto('/settings/privacy');

  await expect(page.locator('[data-gs="wallet-stat-available"]')).toContainText('1,250');
  await expect(page.locator('[data-gs="wallet-stat-held"]')).toContainText('200');
  await expect(page.locator('[data-gs="wallet-stat-bonus"]')).toContainText('300');
  await expect(page.locator('[data-gs="wallet-status-tag"]')).toContainText('账户正常');

  await expect(page.locator('[data-gs="wallet-price-card"]')).toContainText('有效买家线索');
  await expect(page.locator('[data-gs="wallet-price-card"]')).toContainText('验真有效邮箱');
  await expect(page.locator('[data-gs="wallet-lots-card"]')).toContainText('活动赠点');
  await expect(page.locator('[data-gs="wallet-lots-card"]')).toContainText('优先抵扣');
  await expect(page.locator('[data-gs="wallet-lots-card"]')).toContainText('永不过期');

  await page.locator('[data-gs="wallet-ledger-load-more"]').click();
  await expect(page.locator('[data-gs="wallet-ledger-card"]')).toContainText('差额/失败退还');

  await page.locator('[data-gs="wallet-ledger-filter"] .ant-select-selector').click();
  await page.locator('.ant-select-item-option', { hasText: '充值入账' }).click();
  await expect
    .poll(() =>
      calls.some(
        (c) => c.method === 'GET' && c.path === '/wallet/ledger' && c.query.entryType === 'TOPUP',
      ),
    )
    .toBe(true);

  await page.locator('[data-gs="wallet-refresh-btn"]').click();
  await expect
    .poll(() => calls.filter((c) => c.method === 'GET' && c.path === '/wallet/summary').length)
    .toBeGreaterThanOrEqual(2);

  const bodyText = await page.locator('[data-gs="wallet-billing-card"]').innerText();
  expect(bodyText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

test('运营台积分钱包面板：充值、赠点、价目表发布、巡检与毛利对账', async ({ page }) => {
  let topUpPayload: unknown = null;
  let bonusPayload: unknown = null;
  let priceCardPayload: unknown = null;
  let sweepCalled = 0;

  await installSelfContainedApiMock(page, {
    'GET /ops/auth/session': async ({ route }) => {
      await route.fulfill({
        body: JSON.stringify({ data: { user: { email: 'ops@gainos.local' } } }),
        contentType: 'application/json',
        status: 200,
      });
    },
    'GET /ops/overview': async ({ route }) => {
      await route.fulfill({
        body: JSON.stringify({ db: { ok: true }, engine: { httpStatus: 200, ready: true } }),
        contentType: 'application/json',
        status: 200,
      });
    },
    'GET /ops/wallet/accounts': async ({ route }) => {
      await route.fulfill({
        body: JSON.stringify({
          data: [
            {
              availableCredits: '500',
              currency: 'CREDITS',
              heldCredits: '0',
              lifetimeSpent: '100',
              lifetimeToppedUp: '600',
              updatedAt: '2026-11-26T09:00:00.000Z',
              walletStatus: 'ACTIVE',
              workspaceId: OPS_WS_ID,
              workspaceName: 'Pilot Exporter GmbH',
              workspaceStatus: 'ACTIVE',
            },
          ],
        }),
        contentType: 'application/json',
        status: 200,
      });
    },
    'GET /ops/wallet/price-cards': async ({ route }) => {
      await route.fulfill({
        body: JSON.stringify({
          data: [
            {
              actionCode: 'DISCOVERY_QUALIFIED_LEAD',
              active: true,
              createdAt: '2026-11-26T00:00:00.000Z',
              creditsPerUnit: '10',
              defaultHoldUnits: 20,
              displayName: '有效买家线索',
              effectiveFrom: '2026-11-26T00:00:00.000Z',
              effectiveTo: null,
              id: CARD_1_ID,
              pricingMode: 'PER_UNIT_OUTCOME',
              updatedAt: '2026-11-26T00:00:00.000Z',
            },
          ],
        }),
        contentType: 'application/json',
        status: 200,
      });
    },
    'GET /ops/wallet/profit-reconciliation': async ({ route }) => {
      await route.fulfill({
        body: JSON.stringify({
          data: {
            engineCostStatus: 'ok',
            rows: [
              {
                bonusCredits: '200',
                engineCostMicros: '3000000',
                grossMarginPct: 75,
                grossProfitMicros: '9000000',
                ledgerEntries: 12,
                paidRevenueMicros: '12000000',
                releasedCredits: '50',
                settledCredits: '1200',
                topUpCredits: '2000',
                workspaceId: OPS_WS_ID,
                workspaceName: 'Pilot Exporter GmbH',
              },
            ],
            totals: {
              engineCostMicros: '3000000',
              grossMarginPct: 75,
              grossProfitMicros: '9000000',
              paidRevenueMicros: '12000000',
              settledCredits: '1200',
            },
            window: { from: '2026-10-27T00:00:00.000Z', to: '2026-11-26T00:00:00.000Z' },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
    },
    [`POST /ops/wallet/workspaces/${OPS_WS_ID}/top-up`]: async ({ body, route }) => {
      topUpPayload = body;
      await route.fulfill({
        body: JSON.stringify({ data: { idempotent: false } }),
        contentType: 'application/json',
        status: 201,
      });
    },
    [`POST /ops/wallet/workspaces/${OPS_WS_ID}/grant-bonus`]: async ({ body, route }) => {
      bonusPayload = body;
      await route.fulfill({
        body: JSON.stringify({ data: { idempotent: false } }),
        contentType: 'application/json',
        status: 201,
      });
    },
    'POST /ops/wallet/price-cards': async ({ body, route }) => {
      priceCardPayload = body;
      await route.fulfill({
        body: JSON.stringify({ data: { id: CARD_2_ID, ...(body as Record<string, unknown>) } }),
        contentType: 'application/json',
        status: 201,
      });
    },
    'POST /ops/wallet/sweep-expired-holds': async ({ route }) => {
      sweepCalled += 1;
      await route.fulfill({
        body: JSON.stringify({ data: { failed: 0, released: 2, scanned: 2 } }),
        contentType: 'application/json',
        status: 200,
      });
    },
  });

  await page.goto('/ops');
  await page.getByRole('button', { name: '积分钱包' }).click();

  const panel = page.locator('[data-gs="ops-wallet-panel"]');
  await expect(panel).toContainText('Pilot Exporter GmbH');
  await expect(panel.locator('[data-gs="ops-profit-totals"]')).toContainText('$12.00');
  await expect(panel.locator('[data-gs="ops-profit-totals"]')).toContainText('毛利率 75%');

  await page.locator('[data-gs="ops-topup-order"]').fill('wire-20261126-01');
  await page.locator('[data-gs="ops-topup-submit"]').click();
  await expect.poll(() => topUpPayload).toMatchObject({
    credits: '1000',
    externalOrderId: 'wire-20261126-01',
    unitPriceMicros: '10000',
  });

  await page.locator('[data-gs="ops-bonus-order"]').fill('promo-20261126-01');
  await page.locator('[data-gs="ops-bonus-submit"]').click();
  await expect.poll(() => bonusPayload).toMatchObject({
    credits: '200',
    externalOrderId: 'promo-20261126-01',
    sourceType: 'PROMO_BONUS',
  });

  await page.locator('[data-gs="ops-pc-credits"]').fill('12');
  await page.locator('[data-gs="ops-pc-submit"]').click();
  await expect.poll(() => priceCardPayload).toMatchObject({
    actionCode: 'DISCOVERY_QUALIFIED_LEAD',
    creditsPerUnit: '12',
    defaultHoldUnits: 20,
  });

  await page.locator('[data-gs="ops-wallet-sweep-btn"]').click();
  await expect.poll(() => sweepCalled).toBe(1);
});

import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const walletApiMocks = vi.hoisted(() => ({
  ledger: vi.fn(),
  lots: vi.fn(),
  summary: vi.fn(),
}));

vi.mock('#/api/wallet', () => ({
  walletApi: walletApiMocks,
}));

vi.mock('#/locales', () => ({
  $t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

vi.mock('@vben/preferences', () => ({
  preferences: { app: { locale: 'zh-CN' } },
}));

import WalletBillingCard from '#/views/settings/components/wallet-billing-card.vue';

const CARD_ID = '77777777-bbbb-4bbb-8bbb-777777777777';
const LOT_ID = '11111111-bbbb-4bbb-8bbb-111111111111';
const LEDGER_ID = '33333333-bbbb-4bbb-8bbb-333333333333';

describe('WalletBillingCard', () => {
  beforeEach(() => {
    walletApiMocks.summary.mockReset();
    walletApiMocks.lots.mockReset();
    walletApiMocks.ledger.mockReset();

    walletApiMocks.summary.mockResolvedValue({
      account: {
        availableCredits: '1250',
        currency: 'CREDITS',
        heldCredits: '200',
        lifetimeSpent: '450',
        lifetimeToppedUp: '1500',
        status: 'ACTIVE',
        updatedAt: '2026-11-26T10:00:00.000Z',
        version: '5',
        workspaceId: 'ws-test',
      },
      activeHoldsCount: 1,
      billingEnabled: true,
      lotsSummary: {
        activeLotCount: 1,
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
          id: CARD_ID,
          pricingMode: 'PER_UNIT_OUTCOME',
          updatedAt: '2026-11-26T00:00:00.000Z',
        },
      ],
    });
    walletApiMocks.lots.mockResolvedValue([
      {
        createdAt: '2026-11-25T08:00:00.000Z',
        expiresAt: null,
        id: LOT_ID,
        initialCredits: '500',
        priority: 1,
        remainingCredits: '300',
        sourceType: 'PROMO_BONUS',
        workspaceId: 'ws-test',
      },
    ]);
    walletApiMocks.ledger.mockResolvedValue({
      data: [
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
          id: LEDGER_ID,
          idempotencyKey: 'settle:1',
          lotId: LOT_ID,
          refId: null,
          refType: 'discovery_run',
          workspaceId: 'ws-test',
        },
      ],
      page: { has_more: true, next_cursor: LEDGER_ID },
    });
  });

  it('renders wallet KPI stats, pricing, lots and ledger without bare UUIDs or raw <a-*> tags', async () => {
    const wrapper = mount(WalletBillingCard);
    await flushPromises();

    expect(wrapper.find('[data-gs="wallet-stat-available"]').text()).toContain('1,250');
    expect(wrapper.find('[data-gs="wallet-stat-held"]').text()).toContain('200');
    expect(wrapper.find('[data-gs="wallet-stat-bonus"]').text()).toContain('300');
    expect(wrapper.find('[data-gs="wallet-stat-spent"]').text()).toContain('450');
    expect(wrapper.find('[data-gs="wallet-price-card"]').text()).toContain('有效买家线索');
    expect(wrapper.find('[data-gs="wallet-lots-card"]').text()).toContain('活动赠点');
    expect(wrapper.find('[data-gs="wallet-ledger-card"]').text()).toContain('-150');
    expect(wrapper.find('[data-gs="wallet-ledger-load-more"]').exists()).toBe(true);

    // Zero bare UUIDs in rendered text and zero kebab-case <a-*> tags
    expect(wrapper.text()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(wrapper.html()).not.toMatch(/<a-[a-z-]+/i);
  });

  it('loads next ledger page and refreshes on button click', async () => {
    const wrapper = mount(WalletBillingCard);
    await flushPromises();

    walletApiMocks.ledger.mockResolvedValueOnce({
      data: [],
      page: { has_more: false, next_cursor: null },
    });
    await wrapper.find('[data-gs="wallet-ledger-load-more"]').trigger('click');
    await flushPromises();
    expect(walletApiMocks.ledger).toHaveBeenCalledWith({
      cursor: LEDGER_ID,
      limit: 20,
    });

    await wrapper.find('[data-gs="wallet-refresh-btn"]').trigger('click');
    await flushPromises();
    expect(walletApiMocks.summary).toHaveBeenCalledTimes(2);
  });

  it('skips admin-only /lots and /ledger requests for non-admin members', async () => {
    const wrapper = mount(WalletBillingCard, { props: { isAdmin: false } });
    await flushPromises();

    expect(walletApiMocks.summary).toHaveBeenCalledTimes(1);
    expect(walletApiMocks.lots).not.toHaveBeenCalled();
    expect(walletApiMocks.ledger).not.toHaveBeenCalled();
    expect(wrapper.find('[data-gs="wallet-overview-card"]').exists()).toBe(true);
    expect(wrapper.find('[data-gs="wallet-price-card"]').exists()).toBe(true);
    expect(wrapper.find('[data-gs="wallet-lots-card"]').exists()).toBe(false);
    expect(wrapper.find('[data-gs="wallet-ledger-card"]').exists()).toBe(false);
  });
});

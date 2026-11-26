import { baseRequestClient, requestClient } from './request';

export interface WalletAccountView {
  availableCredits: string;
  currency: string;
  heldCredits: string;
  lifetimeSpent: string;
  lifetimeToppedUp: string;
  status: string;
  updatedAt: string;
  version: string;
  workspaceId: string;
}

export interface WalletLotsSummaryView {
  activeLotCount: number;
  bonusCredits: string;
  paidCredits: string;
  soonestExpiryAt: string | null;
  totalActiveCredits: string;
}

export interface BillingPriceCardView {
  actionCode: string;
  active: boolean;
  createdAt: string;
  creditsPerUnit: string;
  defaultHoldUnits: number;
  displayName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  id: string;
  pricingMode: string;
  updatedAt: string;
}

export interface WalletSummaryView {
  account: WalletAccountView;
  activeHoldsCount: number;
  billingEnabled: boolean;
  lotsSummary: WalletLotsSummaryView;
  priceCards: BillingPriceCardView[];
}

export interface WalletCreditLotView {
  createdAt: string;
  expiresAt: string | null;
  id: string;
  initialCredits: string;
  priority: number;
  remainingCredits: string;
  sourceType: string;
  workspaceId: string;
}

export interface WalletLedgerItemView {
  actionCode: string | null;
  balanceAvailable: string;
  balanceHeld: string;
  billableUnits: number | null;
  createdAt: string;
  deltaAvailable: string;
  deltaHeld: string;
  entryType: string;
  holdId: string | null;
  id: string;
  idempotencyKey: string;
  lotId: string | null;
  refId: string | null;
  refType: string | null;
  workspaceId: string;
}

export interface WalletLedgerPageView {
  data: WalletLedgerItemView[];
  page: {
    has_more: boolean;
    next_cursor: string | null;
  };
}

export const walletApi = {
  summary: () => requestClient.get<WalletSummaryView>('/wallet/summary'),
  lots: (limit = 50) =>
    requestClient.get<WalletCreditLotView[]>('/wallet/lots', { params: { limit } }),
  ledger: async (params?: { cursor?: string; entryType?: string; limit?: number }): Promise<WalletLedgerPageView> => {
    const response = await baseRequestClient.get<WalletLedgerPageView>('/wallet/ledger', {
      params,
      withCredentials: true,
    });
    const payload = (response as unknown as { data?: WalletLedgerPageView })?.data ?? (response as unknown as WalletLedgerPageView);
    return {
      data: Array.isArray(payload?.data) ? payload.data : [],
      page: payload?.page ?? { has_more: false, next_cursor: null },
    };
  },
};

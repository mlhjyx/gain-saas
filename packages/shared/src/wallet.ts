/**
 * Prepaid Credits Wallet pure helpers shared across server & web.
 * All credit amounts and micro-USD figures support exact BIGINT strings (no int4 / float precision loss).
 */

export const WALLET_ACTION_CODES = [
  'DISCOVERY_QUALIFIED_LEAD',
  'CONTACT_DISCOVER',
  'CONTACT_ENRICH',
  'CONTACT_VALID_EMAIL',
  'OUTREACH_EMAIL_SENT',
] as const;

export type WalletActionCode = (typeof WALLET_ACTION_CODES)[number];

export const WALLET_ENTRY_TYPES = [
  'TOPUP',
  'PLAN_GRANT',
  'HOLD',
  'SETTLE',
  'RELEASE',
  'REFUND',
  'EXPIRE',
  'ADJUST',
] as const;

export type WalletEntryType = (typeof WALLET_ENTRY_TYPES)[number];

export const WALLET_LOT_SOURCE_TYPES = [
  'TOPUP_PAID',
  'PLAN_GRANT',
  'PROMO_BONUS',
  'MANUAL_ADJUST',
] as const;

export type WalletLotSourceType = (typeof WALLET_LOT_SOURCE_TYPES)[number];

export const WALLET_HOLD_STATUSES = [
  'HELD',
  'SETTLED',
  'RELEASED',
  'EXPIRED_RELEASED',
] as const;

export type WalletHoldStatus = (typeof WALLET_HOLD_STATUSES)[number];

export interface WalletLotSlice {
  readonly sourceType: string;
  readonly remainingCredits: string | bigint | number;
  readonly priority: number;
  readonly expiresAt: string | Date | null;
}

export interface WalletLotsSummary {
  readonly bonusCredits: string;
  readonly paidCredits: string;
  readonly totalActiveCredits: string;
  readonly activeLotCount: number;
  readonly soonestExpiryAt: string | null;
}

const INTEGER_RE = /^-?\d+$/;

export function parseCreditsBigInt(value: string | bigint | number): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new RangeError(`Expected integer credits, got ${value}`);
    }
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!INTEGER_RE.test(trimmed)) {
    throw new RangeError(`Invalid integer credits string: ${value}`);
  }
  return BigInt(trimmed);
}

export function formatCredits(value: string | bigint | number | null | undefined): string {
  if (value === null || value === undefined) return '0';
  const amount = parseCreditsBigInt(value);
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return negative ? `-${grouped}` : grouped;
}

/** 100 Credits = $1.00 (1 Credit = $0.01 = 10,000 micro-USD). */
export function creditsToUsd(credits: string | bigint | number): string {
  const amount = parseCreditsBigInt(credits);
  return formatMicrosUsd(amount * 10_000n);
}

export function formatMicrosUsd(micros: string | bigint | number | null | undefined): string {
  if (micros === null || micros === undefined) return '$0.00';
  const raw = parseCreditsBigInt(micros);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  // Round half-up to cents (10,000 micros = 1 cent)
  const cents = (abs + 5_000n) / 10_000n;
  const dollars = cents / 100n;
  const remCents = (cents % 100n).toString().padStart(2, '0');
  const dollarStr = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${dollarStr}.${remCents}`;
}

/** Gross margin percentage rounded to 1 decimal place; null when revenue <= 0. */
export function computeGrossMarginPct(
  revenueMicros: string | bigint | number,
  costMicros: string | bigint | number,
): number | null {
  const rev = parseCreditsBigInt(revenueMicros);
  const cost = parseCreditsBigInt(costMicros);
  if (rev <= 0n) return null;
  const profit = rev - cost;
  // Use scaled integer math for precision, then convert to number
  const scaled = (profit * 1000n) / rev;
  return Number(scaled) / 10;
}

export function summarizeWalletLots(
  lots: readonly WalletLotSlice[],
  now: Date = new Date(),
): WalletLotsSummary {
  const nowMs = now.getTime();
  let bonus = 0n;
  let paid = 0n;
  let activeLotCount = 0;
  let soonestMs: number | null = null;
  let soonestExpiryAt: string | null = null;

  for (const lot of lots) {
    const remaining = parseCreditsBigInt(lot.remainingCredits);
    if (remaining <= 0n) continue;
    if (lot.expiresAt !== null && lot.expiresAt !== undefined) {
      const exp = lot.expiresAt instanceof Date ? lot.expiresAt : new Date(lot.expiresAt);
      const expMs = exp.getTime();
      if (!Number.isFinite(expMs) || expMs <= nowMs) continue;
      if (soonestMs === null || expMs < soonestMs) {
        soonestMs = expMs;
        soonestExpiryAt = exp.toISOString();
      }
    }
    activeLotCount += 1;
    if (lot.sourceType === 'TOPUP_PAID') {
      paid += remaining;
    } else {
      bonus += remaining;
    }
  }

  return {
    bonusCredits: bonus.toString(),
    paidCredits: paid.toString(),
    totalActiveCredits: (bonus + paid).toString(),
    activeLotCount,
    soonestExpiryAt,
  };
}

function isEn(locale?: string | null): boolean {
  return Boolean(locale && locale.toLowerCase().startsWith('en'));
}

const ACTION_LABELS: Record<string, { zh: string; en: string }> = {
  DISCOVERY_QUALIFIED_LEAD: { zh: '有效买家线索', en: 'Qualified buyer lead' },
  CONTACT_DISCOVER: { zh: '决策人线索发现', en: 'Decision-maker discovery' },
  CONTACT_ENRICH: { zh: '联系人信息补全', en: 'Contact enrichment' },
  CONTACT_VALID_EMAIL: { zh: '验真有效邮箱', en: 'Verified valid e-mail' },
  OUTREACH_EMAIL_SENT: { zh: '成功发送开发信', en: 'Delivered outreach e-mail' },
};

const ENTRY_TYPE_LABELS: Record<string, { zh: string; en: string }> = {
  TOPUP: { zh: '充值入账', en: 'Top-up' },
  PLAN_GRANT: { zh: '赠送入账', en: 'Bonus grant' },
  HOLD: { zh: '任务预占', en: 'Held' },
  SETTLE: { zh: '有效产出实扣', en: 'Settled' },
  RELEASE: { zh: '差额/失败退还', en: 'Released' },
  REFUND: { zh: '人工退款', en: 'Refunded' },
  EXPIRE: { zh: '到期/超时退还', en: 'Expired' },
  ADJUST: { zh: '额度调整', en: 'Adjustment' },
};

const LOT_SOURCE_LABELS: Record<string, { zh: string; en: string }> = {
  TOPUP_PAID: { zh: '付费充值', en: 'Paid top-up' },
  PLAN_GRANT: { zh: '套餐赠点', en: 'Plan grant' },
  PROMO_BONUS: { zh: '活动赠点', en: 'Promotional bonus' },
  MANUAL_ADJUST: { zh: '运营调整', en: 'Manual adjustment' },
};

const HOLD_STATUS_LABELS: Record<string, { zh: string; en: string }> = {
  HELD: { zh: '预占中', en: 'Held' },
  SETTLED: { zh: '已结算', en: 'Settled' },
  RELEASED: { zh: '已退还', en: 'Released' },
  EXPIRED_RELEASED: { zh: '超时已退还', en: 'Expired & released' },
};

export function walletActionLabel(actionCode?: string | null, locale?: string | null): string {
  if (!actionCode) return '—';
  const entry = ACTION_LABELS[actionCode];
  if (!entry) return actionCode;
  return isEn(locale) ? entry.en : entry.zh;
}

export function walletEntryTypeLabel(entryType?: string | null, locale?: string | null): string {
  if (!entryType) return '—';
  const entry = ENTRY_TYPE_LABELS[entryType];
  if (!entry) return entryType;
  return isEn(locale) ? entry.en : entry.zh;
}

export function walletLotSourceLabel(sourceType?: string | null, locale?: string | null): string {
  if (!sourceType) return '—';
  const entry = LOT_SOURCE_LABELS[sourceType];
  if (!entry) return sourceType;
  return isEn(locale) ? entry.en : entry.zh;
}

export function walletHoldStatusLabel(status?: string | null, locale?: string | null): string {
  if (!status) return '—';
  const entry = HOLD_STATUS_LABELS[status];
  if (!entry) return status;
  return isEn(locale) ? entry.en : entry.zh;
}

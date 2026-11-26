import { describe, expect, it } from 'vitest';
import {
  WALLET_ACTION_CODES,
  computeGrossMarginPct,
  creditsToUsd,
  formatCredits,
  formatMicrosUsd,
  parseCreditsBigInt,
  summarizeWalletLots,
  walletActionLabel,
  walletEntryTypeLabel,
  walletHoldStatusLabel,
  walletLotSourceLabel,
} from './wallet.js';

describe('shared wallet pure logic', () => {
  it('parses and formats BIGINT credit strings safely beyond MAX_SAFE_INTEGER', () => {
    expect(parseCreditsBigInt('0')).toBe(0n);
    expect(parseCreditsBigInt('123456')).toBe(123456n);
    expect(parseCreditsBigInt('9007199254740995')).toBe(9007199254740995n);
    expect(parseCreditsBigInt('-50')).toBe(-50n);
    expect(() => parseCreditsBigInt('12.5')).toThrow();
    expect(() => parseCreditsBigInt('abc')).toThrow();

    expect(formatCredits(0)).toBe('0');
    expect(formatCredits('12500')).toBe('12,500');
    expect(formatCredits('-2500')).toBe('-2,500');
    expect(formatCredits(9007199254740995n)).toBe('9,007,199,254,740,995');
  });

  it('converts credits & micros USD and computes gross margin cleanly', () => {
    // 100 credits = $1.00 (1 credit = $0.01)
    expect(creditsToUsd('100')).toBe('$1.00');
    expect(creditsToUsd('2550')).toBe('$25.50');
    expect(creditsToUsd('0')).toBe('$0.00');

    expect(formatMicrosUsd('1500000')).toBe('$1.50');
    expect(formatMicrosUsd('25000')).toBe('$0.03');
    expect(formatMicrosUsd('-500000')).toBe('-$0.50');

    expect(computeGrossMarginPct('10000000', '3000000')).toBe(70);
    expect(computeGrossMarginPct('0', '1000000')).toBeNull();
    expect(computeGrossMarginPct('1000000', '1250000')).toBe(-25);
  });

  it('summarizes active bonus vs paid lots and ignores expired or empty lots', () => {
    const now = new Date('2026-11-26T12:00:00.000Z');
    const summary = summarizeWalletLots(
      [
        {
          sourceType: 'PROMO_BONUS',
          remainingCredits: '300',
          priority: 1,
          expiresAt: '2026-12-01T00:00:00.000Z',
        },
        {
          sourceType: 'PLAN_GRANT',
          remainingCredits: '500',
          priority: 1,
          expiresAt: '2026-11-28T00:00:00.000Z',
        },
        {
          sourceType: 'PROMO_BONUS',
          remainingCredits: '999',
          priority: 1,
          expiresAt: '2026-11-20T00:00:00.000Z', // expired
        },
        {
          sourceType: 'TOPUP_PAID',
          remainingCredits: '2000',
          priority: 10,
          expiresAt: null,
        },
        {
          sourceType: 'TOPUP_PAID',
          remainingCredits: '0',
          priority: 10,
          expiresAt: null,
        },
      ],
      now,
    );
    expect(summary).toEqual({
      bonusCredits: '800',
      paidCredits: '2000',
      totalActiveCredits: '2800',
      activeLotCount: 3,
      soonestExpiryAt: '2026-11-28T00:00:00.000Z',
    });
  });

  it('maps wallet enums and action codes to business-friendly bilingual labels', () => {
    expect(WALLET_ACTION_CODES).toContain('DISCOVERY_QUALIFIED_LEAD');
    expect(WALLET_ACTION_CODES).toContain('CONTACT_VALID_EMAIL');
    expect(walletActionLabel('DISCOVERY_QUALIFIED_LEAD', 'zh-CN')).toBe('有效买家线索');
    expect(walletActionLabel('CONTACT_VALID_EMAIL', 'en-US')).toBe('Verified valid e-mail');
    expect(walletEntryTypeLabel('TOPUP', 'zh-CN')).toBe('充值入账');
    expect(walletEntryTypeLabel('RELEASE', 'en-US')).toBe('Released');
    expect(walletLotSourceLabel('TOPUP_PAID', 'zh-CN')).toBe('付费充值');
    expect(walletLotSourceLabel('PROMO_BONUS', 'en-US')).toBe('Promotional bonus');
    expect(walletHoldStatusLabel('EXPIRED_RELEASED', 'zh-CN')).toBe('超时已退还');
  });
});

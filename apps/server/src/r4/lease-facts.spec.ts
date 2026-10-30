import { describe, expect, it } from 'vitest';
import { LEASE_MAX_AGE_MS, toConsumerFact } from './lease-facts.js';

const NOW = 1_700_000_000_000;
const lease = (overrides: Partial<{ state: string; lastSeenAt: number | null; expiresAt: number | null }> = {}) => ({
  state: 'ACTIVE',
  lastSeenAt: NOW - 1_000,
  expiresAt: NOW + 5_000,
  ...overrides,
});
const noBacklog = { pending: 0, oldestCreatedAt: null };

describe('租约事实', () => {
  it('ACTIVE 且心跳新鲜时给出事实，窗口不超过 30 秒', () => {
    const fact = toConsumerFact('acq-sweep', lease(), noBacklog, NOW);
    expect(fact).not.toBeNull();
    expect(fact!.observedAt).toBe(NOW - 1_000);
    expect(fact!.validUntil - fact!.observedAt).toBeLessThanOrEqual(LEASE_MAX_AGE_MS);
    expect(fact!.undeliveredCount).toBe(0);
    expect(fact!.oldestUndeliveredCreatedAt).toBeNull();
  });

  it('RELEASED / 心跳过期 / 租约过期 都不给事实', () => {
    expect(toConsumerFact('s', lease({ state: 'RELEASED' }), noBacklog, NOW)).toBeNull();
    expect(toConsumerFact('s', lease({ lastSeenAt: NOW - 31_000 }), noBacklog, NOW)).toBeNull();
    expect(toConsumerFact('s', lease({ expiresAt: NOW - 1 }), noBacklog, NOW)).toBeNull();
    expect(toConsumerFact('s', lease({ lastSeenAt: null }), noBacklog, NOW)).toBeNull();
  });

  it('积压超过 30 秒不给事实；未超时则带上计数与最老时间', () => {
    expect(
      toConsumerFact('s', lease(), { pending: 3, oldestCreatedAt: NOW - 31_000 }, NOW),
    ).toBeNull();
    const fact = toConsumerFact('s', lease(), { pending: 3, oldestCreatedAt: NOW - 5_000 }, NOW);
    expect(fact).not.toBeNull();
    expect(fact!.undeliveredCount).toBe(3);
    expect(fact!.oldestUndeliveredCreatedAt).toBe(NOW - 5_000);
  });

  it('无积压却带 oldest、负数积压都给不出事实', () => {
    expect(toConsumerFact('s', lease(), { pending: 0, oldestCreatedAt: NOW - 1_000 }, NOW)).toBeNull();
    expect(toConsumerFact('s', lease(), { pending: -1, oldestCreatedAt: null }, NOW)).toBeNull();
  });
});

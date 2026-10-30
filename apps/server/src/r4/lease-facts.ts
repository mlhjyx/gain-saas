import type { RevocationConsumerFact } from './platform-facts.service.js';

/**
 * 租约与积压 → capability 的 revocationConsumer 事实（P6）。
 *
 * 纯函数，便于在无库环境测试。规则与引擎的 freshness 一致：
 *  - 只有 ACTIVE 且心跳在 30 秒内才算出事实
 *  - 事实窗口不超过 30 秒
 *  - 有积压且最老一条超过 30 秒 → 不算事实（调用方据此拒签 capability）
 */

export const LEASE_MAX_AGE_MS = 30_000;

export interface LeaseSnapshot {
  state: string;
  lastSeenAt: number | null;
  expiresAt: number | null;
}

export interface BacklogSnapshot {
  pending: number;
  oldestCreatedAt: number | null;
}

export function toConsumerFact(
  scheduleId: string,
  lease: LeaseSnapshot,
  backlog: BacklogSnapshot,
  now: number,
): RevocationConsumerFact | null {
  if (lease.state !== 'ACTIVE') return null;
  if (lease.lastSeenAt === null || lease.expiresAt === null) return null;
  if (lease.lastSeenAt > now) return null;
  if (now - lease.lastSeenAt >= LEASE_MAX_AGE_MS) return null;
  if (lease.expiresAt <= now) return null;

  const validUntil = Math.min(lease.expiresAt, lease.lastSeenAt + LEASE_MAX_AGE_MS);
  if (validUntil <= lease.lastSeenAt) return null;

  if (!Number.isInteger(backlog.pending) || backlog.pending < 0) return null;
  if (backlog.pending === 0) {
    if (backlog.oldestCreatedAt !== null) return null;
    return { scheduleId, observedAt: lease.lastSeenAt, validUntil, undeliveredCount: 0, oldestUndeliveredCreatedAt: null };
  }
  const oldest = backlog.oldestCreatedAt;
  if (oldest === null || !Number.isInteger(oldest)) return null;
  if (oldest > now) return null;
  if (now - oldest >= LEASE_MAX_AGE_MS) return null;
  return { scheduleId, observedAt: lease.lastSeenAt, validUntil, undeliveredCount: backlog.pending, oldestUndeliveredCreatedAt: oldest };
}

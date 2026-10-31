import { Injectable } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service.js';
import { PLATFORM_SCHEDULES } from './contracts/r4-wire-contracts.js';
import { toConsumerFact, type BacklogSnapshot, type LeaseSnapshot } from './lease-facts.js';
import type { RevocationBacklogProbe, RevocationConsumerFact } from './platform-facts.service.js';
import { BACKLOG_REQUEST_STATES } from './platform-revocation.service.js';

/**
 * 撤销消费者租约（P6）。
 *
 * 消费者（platform worker 侧的撤销投递器）定期 renew；capability 只认
 * 「ACTIVE 且心跳 ≤30 秒」的租约。这样能力签发与「撤销确实有人消费」绑在一起，
 * 和 GrowthOS 的语义一致。
 */
// consumer 事实的 validUntil = lastSeenAt + TTL。引擎每 10 秒刷新一次 capability，
// 且只在 `now < row.validUntil` 时判 ok；TTL 取 20 秒才能盖住整个刷新周期
// （10 秒会出现 up to 数秒的 TEMPORAL_PROOF_UNAVAILABLE 抖动）。上限由引擎的
// 30 秒 consumer 窗口约束，不能超过。
export const LEASE_TTL_MS = 20_000;

@Injectable()
export class R4LeaseService implements RevocationBacklogProbe {
  constructor(private readonly prisma: PrismaService) {}

  async renew(scheduleId: string, now = Date.now()): Promise<void> {
    const expiresAt = new Date(now + LEASE_TTL_MS);
    await this.prisma.r4ConsumerLease.upsert({
      where: { scheduleId },
      create: {
        scheduleId,
        state: 'ACTIVE',
        generation: 1n,
        ownershipGeneration: 1n,
        lastSeenAt: new Date(now),
        expiresAt,
      },
      update: {
        state: 'ACTIVE',
        lastSeenAt: new Date(now),
        expiresAt,
        lastTickAt: new Date(now),
        generation: { increment: 1n },
        ownershipGeneration: { increment: 1n },
      },
    });
  }

  async release(scheduleId: string, now = Date.now()): Promise<void> {
    await this.prisma.r4ConsumerLease.updateMany({
      where: { scheduleId },
      data: { state: 'RELEASED', lastSeenAt: new Date(now), expiresAt: new Date(now) },
    });
  }

  async read(now: number): Promise<RevocationConsumerFact[] | null> {
    const leases = await this.prisma.r4ConsumerLease.findMany();
    if (leases.length === 0) return null;
    const facts: RevocationConsumerFact[] = [];
    for (const scheduleId of PLATFORM_SCHEDULES) {
      const lease = leases.find((row) => row.scheduleId === scheduleId);
      if (!lease) return null;
      const backlog = await this.backlog(scheduleId, now);
      const fact = toConsumerFact(scheduleId, this.snapshot(lease), backlog, now);
      if (!fact) return null;
      facts.push(fact);
    }
    return facts;
  }

  /**
   * 积压 = 没有拿到真实 ACK 的**逻辑撤销请求**（P9 起读 r4_revocation_request）。
   * 刻意不计 PENDING_CONFIRMATION（等待人工确认的刻意门）与 NO_LIVE_TARGET（已解决）；
   * PENDING / BLOCKED / STORED_STATE_CONFLICT 都算未交付，超过 30 秒即关闭 capability。
   */
  private async backlog(scheduleId: string, now: number): Promise<BacklogSnapshot> {
    const where = { scheduleId, state: { in: [...BACKLOG_REQUEST_STATES] } };
    const pending = await this.prisma.r4RevocationRequest.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 1,
      select: { createdAt: true },
    });
    const count = await this.prisma.r4RevocationRequest.count({ where });
    return {
      pending: count,
      oldestCreatedAt: pending[0] ? pending[0].createdAt.getTime() : null,
    };
  }

  private snapshot(lease: {
    state: string;
    lastSeenAt: Date | null;
    expiresAt: Date | null;
  }): LeaseSnapshot {
    return {
      state: lease.state,
      lastSeenAt: lease.lastSeenAt ? lease.lastSeenAt.getTime() : null,
      expiresAt: lease.expiresAt ? lease.expiresAt.getTime() : null,
    };
  }
}

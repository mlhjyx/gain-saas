import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

export interface ThrottlePolicy {
  limit: number;
  windowMs: number;
}

export const THROTTLE_POLICIES = {
  tenantLogin: { limit: 5, windowMs: 15 * 60 * 1000 },
  tenantRegister: { limit: 5, windowMs: 60 * 60 * 1000 },
  tenantAcceptInvite: { limit: 10, windowMs: 15 * 60 * 1000 },
  opsLogin: { limit: 5, windowMs: 15 * 60 * 1000 },
  // 官网合作意向（公开端点，无登录态）：IP 短窗防连点/脚本刷，IP 日窗防批量；
  // 邮箱日窗防同一联系人被反复提交。按 HMAC 摘要计数，不落明文 IP/邮箱键。
  cooperationIntentIp: { limit: 5, windowMs: 10 * 60 * 1000 },
  cooperationIntentIpDaily: { limit: 30, windowMs: 24 * 60 * 60 * 1000 },
  cooperationIntentEmailDaily: { limit: 3, windowMs: 24 * 60 * 60 * 1000 },
} as const satisfies Record<string, ThrottlePolicy>;

/**
 * 持久化失败尝试限流:替代单进程内存 Map。
 * 重启不丢、多个 web 实例共享;窗口从首次尝试固定,成功后可清除。
 */
@Injectable()
export class AuthThrottleService {
  constructor(private readonly prisma: PrismaService) {}

  async check(key: string, policy: ThrottlePolicy): Promise<void> {
    const entry = await this.prisma.authThrottle.findUnique({ where: { key } });
    if (!entry) return;
    if (entry.resetAt.getTime() <= Date.now()) {
      await this.prisma.authThrottle.deleteMany({ where: { key, resetAt: { lte: new Date() } } }).catch(() => undefined);
      return;
    }
    if (entry.count >= policy.limit) {
      throw new HttpException(
        { error: { code: 'RATE_LIMITED', message: '尝试过多，请稍后再试' } },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** 记一次尝试;窗口从首次尝试开始,不因后续尝试延长。 */
  async hit(key: string, policy: ThrottlePolicy): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.authThrottle.deleteMany({ where: { key, resetAt: { lte: now } } });
      await tx.authThrottle.upsert({
        where: { key },
        create: { key, count: 1, resetAt: new Date(now.getTime() + policy.windowMs) },
        update: { count: { increment: 1 } },
      });
    });
  }

  /**
   * 原子「检查+计数」：单条 SQL 在行锁内完成窗口重置与自增，避免
   * check()/hit() 两步之间的并发窗口（匿名端点被并行请求打穿）。
   * 超限时抛 429，并在 error.retryAfterSeconds 给出当前窗口剩余秒数。
   */
  async consume(key: string, policy: ThrottlePolicy): Promise<void> {
    const now = new Date();
    const resetAt = new Date(now.getTime() + policy.windowMs);
    const rows = await this.prisma.$queryRaw<Array<{ count: number; retry_after_seconds: number }>>`
      INSERT INTO "auth_throttle" ("key", "count", "reset_at", "updated_at")
      VALUES (${key}, 1, ${resetAt}, ${now})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE
          WHEN "auth_throttle"."reset_at" <= ${now} THEN 1
          ELSE "auth_throttle"."count" + 1
        END,
        "reset_at" = CASE
          WHEN "auth_throttle"."reset_at" <= ${now} THEN ${resetAt}
          ELSE "auth_throttle"."reset_at"
        END,
        "updated_at" = ${now}
      RETURNING "count",
        GREATEST(1, CEIL(EXTRACT(EPOCH FROM ("reset_at" - LOCALTIMESTAMP))))::int AS "retry_after_seconds"
    `;
    const row = rows[0];
    if (row && row.count > policy.limit) {
      const retryAfterSeconds = row.retry_after_seconds > 0 ? row.retry_after_seconds : 600;
      throw new HttpException(
        { error: { code: 'RATE_LIMITED', message: '尝试过多，请稍后再试', retryAfterSeconds } },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async success(key: string): Promise<void> {
    await this.prisma.authThrottle.deleteMany({ where: { key } }).catch(() => undefined);
  }
}

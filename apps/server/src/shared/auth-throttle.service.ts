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

  async success(key: string): Promise<void> {
    await this.prisma.authThrottle.deleteMany({ where: { key } }).catch(() => undefined);
  }
}

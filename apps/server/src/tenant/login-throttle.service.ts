import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;

interface Attempt {
  count: number;
  resetAt: number;
}

/** 开发期单进程登录限流：同一 IP + 邮箱 15 分钟内最多 5 次失败。 */
@Injectable()
export class LoginThrottleService {
  private readonly attempts = new Map<string, Attempt>();

  check(key: string): void {
    const entry = this.attempts.get(key);
    if (!entry) return;
    if (Date.now() >= entry.resetAt) {
      this.attempts.delete(key);
      return;
    }
    if (entry.count >= MAX_FAILURES) {
      throw new HttpException(
        { error: { code: 'RATE_LIMITED', message: '登录尝试过多，请 15 分钟后再试' } },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  fail(key: string): void {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || now >= entry.resetAt) {
      this.attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return;
    }
    entry.count += 1;
  }

  success(key: string): void {
    this.attempts.delete(key);
  }
}

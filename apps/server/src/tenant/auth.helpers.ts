/** 认证域的纯函数(便于单测):校验、令牌、过期计算。 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length <= 254 && EMAIL_RE.test(normalized) ? normalized : null;
}

export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string') return null;
  // 一期策略:≥10 位,须含字母与数字;上限 128 防止 argon2 DoS
  return password.length >= 10 && password.length <= 128 && /[a-zA-Z]/.test(password) && /\d/.test(password)
    ? password
    : null;
}

export function normalizeRole(role: unknown): 'admin' | 'member' | null {
  return role === 'admin' || role === 'member' ? role : null;
}

export function invitationExpiry(now = new Date(), days = 7): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

export function isInvitationUsable(
  invitation: { expiresAt: Date; acceptedAt: Date | null },
  now = new Date(),
): boolean {
  return invitation.acceptedAt === null && invitation.expiresAt.getTime() > now.getTime();
}

/** 会话滑动刷新:剩余不足一半 TTL 时重发 cookie。 */
export function shouldRefreshSession(expSeconds: number, ttlSeconds: number, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return expSeconds - nowSec < ttlSeconds / 2;
}

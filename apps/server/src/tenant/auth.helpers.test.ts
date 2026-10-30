import { describe, expect, it } from 'vitest';
import {
  invitationExpiry,
  isInvitationUsable,
  normalizeRole,
  shouldRefreshSession,
  validateEmail,
  validatePassword,
} from './auth.helpers.js';

describe('validateEmail', () => {
  it('规范化大小写与空白', () => {
    expect(validateEmail('  A@B.com ')).toBe('a@b.com');
  });
  it('拒绝明显非法值', () => {
    expect(validateEmail('no-at-sign')).toBeNull();
    expect(validateEmail(42)).toBeNull();
  });
});

describe('validatePassword', () => {
  it('≥10 位且含字母数字通过', () => {
    expect(validatePassword('abcd1234ef')).toBe('abcd1234ef');
  });
  it('太短 / 无数字 / 超长都拒绝', () => {
    expect(validatePassword('ab1')).toBeNull();
    expect(validatePassword('abcdefghijk')).toBeNull();
    expect(validatePassword('x'.repeat(129) + '1')).toBeNull();
  });
});

describe('邀请', () => {
  it('未使用且未过期才可用', () => {
    const now = new Date('2026-10-29T00:00:00Z');
    expect(isInvitationUsable({ expiresAt: new Date('2026-11-05T00:00:00Z'), acceptedAt: null }, now)).toBe(true);
    expect(isInvitationUsable({ expiresAt: new Date('2026-11-05T00:00:00Z'), acceptedAt: now }, now)).toBe(false);
    expect(isInvitationUsable({ expiresAt: new Date('2026-10-01T00:00:00Z'), acceptedAt: null }, now)).toBe(false);
  });
  it('默认 7 天有效', () => {
    const now = new Date('2026-10-29T00:00:00Z');
    expect(invitationExpiry(now).toISOString()).toBe('2026-11-05T00:00:00.000Z');
  });
});

describe('normalizeRole', () => {
  it('只接受 admin/member', () => {
    expect(normalizeRole('admin')).toBe('admin');
    expect(normalizeRole('owner')).toBeNull();
  });
});

describe('会话滑动续期', () => {
  it('剩余不足一半 TTL 触发刷新', () => {
    const now = 1000;
    expect(shouldRefreshSession(1000 + 20, 60, now)).toBe(true); // 剩 20 < 30
    expect(shouldRefreshSession(1000 + 50, 60, now)).toBe(false); // 剩 50 > 30
    expect(shouldRefreshSession(1000 + 10, 60, now)).toBe(true);
  });
});

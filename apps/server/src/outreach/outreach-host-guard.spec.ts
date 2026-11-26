import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  assertSafeMailHost,
  isPrivateOrReservedIp,
  resolveAndAssertSafeMailHost,
} from './outreach-host-guard.js';

describe('outreach-host-guard (BYO SMTP/IMAP SSRF protection)', () => {
  it('blocks loopback, RFC1918, cloud metadata, CGNAT, and IPv6 private ranges', () => {
    expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('10.0.0.5')).toBe(true);
    expect(isPrivateOrReservedIp('172.16.1.1')).toBe(true);
    expect(isPrivateOrReservedIp('192.168.1.1')).toBe(true);
    expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedIp('100.64.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('::1')).toBe(true);
    expect(isPrivateOrReservedIp('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isPrivateOrReservedIp('0::1')).toBe(true);
    expect(isPrivateOrReservedIp('0:0:0:0:0:0:0:0')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('0:0:0:0:0:ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('0:0:0:0:0:ffff:169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedIp('::127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('64:ff9b::127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('64:ff9b::169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedIp('64:ff9b:1::1')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:0:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('2002:7f00:1::')).toBe(true);
    expect(isPrivateOrReservedIp('100::1')).toBe(true);
    expect(isPrivateOrReservedIp('2001:db8::1')).toBe(true);
    expect(isPrivateOrReservedIp('fe80::1')).toBe(true);
    expect(isPrivateOrReservedIp('fe80::1%eth0')).toBe(true);
    expect(isPrivateOrReservedIp('fc00::1')).toBe(true);
    expect(isPrivateOrReservedIp('ff02::1')).toBe(true);

    expect(isPrivateOrReservedIp('74.125.133.108')).toBe(false);
    expect(isPrivateOrReservedIp('::ffff:74.125.133.108')).toBe(false);
    expect(isPrivateOrReservedIp('2607:f8b0:4004:c07::6c')).toBe(false);
  });

  it('rejects private/internal hosts and non-standard ports unless allowPrivate=true', () => {
    expect(() => assertSafeMailHost('localhost', 587, 'smtp')).toThrow(BadRequestException);
    expect(() => assertSafeMailHost('redis.internal', 587, 'smtp')).toThrow(BadRequestException);
    expect(() => assertSafeMailHost('169.254.169.254', 587, 'smtp')).toThrow(BadRequestException);
    expect(() => assertSafeMailHost('smtp.gmail.com', 6379, 'smtp')).toThrow(BadRequestException);
    expect(() => assertSafeMailHost('imap.gmail.com', 5432, 'imap')).toThrow(BadRequestException);

    expect(assertSafeMailHost('smtp.gmail.com', 465, 'smtp')).toEqual({
      host: 'smtp.gmail.com',
      port: 465,
    });
    expect(assertSafeMailHost('imap.gmail.com', 993, 'imap')).toEqual({
      host: 'imap.gmail.com',
      port: 993,
    });
    expect(assertSafeMailHost('127.0.0.1', 15870, 'smtp', { allowPrivate: true })).toEqual({
      host: '127.0.0.1',
      port: 15870,
    });
  });

  it('blocks DNS rebinding to private IPs during live resolution', async () => {
    await expect(
      resolveAndAssertSafeMailHost('evil.example.com', 587, 'smtp', {
        lookup: async () => [{ address: '10.0.0.12', family: 4 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const ok = await resolveAndAssertSafeMailHost('smtp.office365.com', 587, 'smtp', {
      lookup: async () => [{ address: '52.96.191.226', family: 4 }],
    });
    expect(ok.resolvedAddress).toBe('52.96.191.226');
  });
});

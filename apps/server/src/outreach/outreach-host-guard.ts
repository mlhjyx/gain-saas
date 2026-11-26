import { BadRequestException } from '@nestjs/common';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const RESERVED_TLDS = new Set(['local', 'internal', 'localhost', 'arpa', 'lan', 'home', 'corp', 'intranet']);

export const ALLOWED_SMTP_PORTS = new Set([25, 465, 587, 2525]);
export const ALLOWED_IMAP_PORTS = new Set([143, 993]);

export interface MailHostGuardOptions {
  readonly allowPrivate?: boolean;
  readonly lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

function rejectHost(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

function isPrivateIpv4Octets(a: number, b: number, c: number, d: number): boolean {
  if (
    ![a, b, c, d].every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  ) {
    return true;
  }
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // Link-local & cloud metadata 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16.0.0/12
  if (a === 192 && b === 168) return true; // RFC1918 192.168.0.0/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // Benchmark 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // Multicast & reserved 224.0.0.0/4+
  return false;
}

/** 将任意合法 IPv6 字面量（含非压缩形式、%zone 与末尾点分 IPv4）完整展开为 8 个 16-bit hextet。 */
function parseIpv6Hextets(raw: string): number[] | null {
  const withoutZone = raw.split('%')[0]!.trim().toLowerCase();
  if (!withoutZone) return null;

  let working = withoutZone;
  // 处理末尾内嵌点分 IPv4（如 ::ffff:127.0.0.1、0:0:0:0:0:ffff:169.254.169.254、64:ff9b::127.0.0.1）
  const lastColon = working.lastIndexOf(':');
  if (lastColon !== -1 && working.slice(lastColon + 1).includes('.')) {
    const v4Part = working.slice(lastColon + 1);
    if (isIP(v4Part) !== 4) return null;
    const octets = v4Part.split('.').map(Number);
    if (octets.length !== 4) return null;
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    working = `${working.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const doubleColonParts = working.split('::');
  if (doubleColonParts.length > 2) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (!segment) return [];
    const groups = segment.split(':');
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };

  if (doubleColonParts.length === 1) {
    const groups = parseGroups(doubleColonParts[0]!);
    return groups && groups.length === 8 ? groups : null;
  }

  const left = parseGroups(doubleColonParts[0]!);
  const right = parseGroups(doubleColonParts[1]!);
  if (!left || !right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isPrivateEmbeddedIpv4(hi: number, lo: number): boolean {
  return isPrivateIpv4Octets((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff);
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const raw = ip.trim().toLowerCase();
  const withoutZone = raw.split('%')[0]!;
  const version = isIP(withoutZone);
  if (version === 4) {
    const parts = withoutZone.split('.').map(Number);
    if (parts.length !== 4) return true;
    return isPrivateIpv4Octets(parts[0]!, parts[1]!, parts[2]!, parts[3]!);
  }
  if (version === 6) {
    const h = parseIpv6Hextets(raw);
    if (!h) return true;
    const [h0, h1, h2, h3, h4, h5, h6, h7] = h as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    // ::/128 (unspecified) & ::1/128 (loopback) & ::/96 (deprecated IPv4-compatible e.g. ::127.0.0.1)
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) return true;
    // ::ffff:0:0/96 (IPv4-mapped IPv6, 含非压缩 0:0:0:0:0:ffff:127.0.0.1 / 169.254.169.254)
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
      return isPrivateEmbeddedIpv4(h6, h7);
    }
    // ::ffff:0:0:0/96 (SIIT IPv4-translated, e.g. ::ffff:0:127.0.0.1)
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0xffff && h5 === 0) {
      return true;
    }
    // 64:ff9b::/96 (NAT64 well-known prefix) & 64:ff9b:1::/48 (NAT64 local-use)
    if (h0 === 0x0064 && h1 === 0xff9b) {
      if (h2 === 0x0001) return true;
      if (h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
        return isPrivateEmbeddedIpv4(h6, h7);
      }
    }
    // 100::/64 (discard-only RFC 6666)
    if (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) return true;
    // 2001:db8::/32 (documentation)
    if (h0 === 0x2001 && h1 === 0x0db8) return true;
    // 2002::/16 (6to4, 禁止含私网/或直接拦截已废弃隧道段)
    if (h0 === 0x2002) return true;
    // fc00::/7 (ULA)
    if ((h0 & 0xfe00) === 0xfc00) return true;
    // fe80::/10 (link-local) & fec0::/10 (deprecated site-local)
    if ((h0 & 0xffc0) === 0xfe80 || (h0 & 0xffc0) === 0xfec0) return true;
    // ff00::/8 (multicast)
    if ((h0 & 0xff00) === 0xff00) return true;
    return false;
  }
  return true;
}

export function assertSafeMailHost(
  rawHost: string,
  port: number,
  kind: 'smtp' | 'imap',
  options: MailHostGuardOptions = {},
): { host: string; port: number } {
  const host = rawHost.trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || /[\s\r\n/\\:@]/.test(host)) {
    rejectHost(`${kind.toUpperCase()} 主机地址格式不合法`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    rejectHost(`${kind.toUpperCase()} 端口必须是 1..65535 的整数`);
  }
  if (!options.allowPrivate) {
    const allowedPorts = kind === 'smtp' ? ALLOWED_SMTP_PORTS : ALLOWED_IMAP_PORTS;
    if (!allowedPorts.has(port)) {
      rejectHost(
        `${kind.toUpperCase()} 端口仅允许标准邮件端口（${[...allowedPorts].join('/')}）`,
      );
    }
    if (isIP(host) !== 0) {
      if (isPrivateOrReservedIp(host)) {
        rejectHost(`${kind.toUpperCase()} 禁止指向内网或回环 IP`);
      }
      return { host, port };
    }
    if (host === 'localhost' || !HOSTNAME_RE.test(host)) {
      rejectHost(`${kind.toUpperCase()} 必须是合法公网域名`);
    }
    const tld = host.split('.').pop() ?? '';
    if (RESERVED_TLDS.has(tld)) {
      rejectHost(`${kind.toUpperCase()} 禁止使用保留内网域名后缀 .${tld}`);
    }
  }
  return { host, port };
}

export async function resolveAndAssertSafeMailHost(
  rawHost: string,
  port: number,
  kind: 'smtp' | 'imap',
  options: MailHostGuardOptions = {},
): Promise<{ host: string; port: number; resolvedAddress?: string }> {
  const safe = assertSafeMailHost(rawHost, port, kind, options);
  if (options.allowPrivate) return safe;
  if (isIP(safe.host) !== 0) {
    return { ...safe, resolvedAddress: safe.host };
  }
  const resolver =
    options.lookup ??
    (async (hostname: string) => {
      const res = await dnsLookup(hostname, { all: true });
      return res;
    });
  let records: Array<{ address: string; family: number }>;
  try {
    records = await resolver(safe.host);
  } catch {
    rejectHost(`${kind.toUpperCase()} 主机 ${safe.host} DNS 解析失败`);
  }
  if (!records || records.length === 0) {
    rejectHost(`${kind.toUpperCase()} 主机 ${safe.host} 无可用 DNS 记录`);
  }
  for (const rec of records) {
    if (isPrivateOrReservedIp(rec.address)) {
      rejectHost(`${kind.toUpperCase()} 主机 ${safe.host} 解析到内网/保留地址，已拒绝连接`);
    }
  }
  return { ...safe, resolvedAddress: records[0]!.address };
}

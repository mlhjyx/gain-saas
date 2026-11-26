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

export function isPrivateOrReservedIp(ip: string): boolean {
  const clean = ip.trim().toLowerCase();
  if (clean.startsWith('::ffff:')) {
    return isPrivateOrReservedIp(clean.slice(7));
  }
  const version = isIP(clean);
  if (version === 4) {
    const parts = clean.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = parts as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 169 && b === 254) return true; // Link-local & cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true; // Benchmark
    if (a >= 224) return true; // Multicast & reserved
    return false;
  }
  if (version === 6) {
    if (clean === '::' || clean === '::1') return true;
    if (clean.startsWith('fc') || clean.startsWith('fd')) return true; // ULA fc00::/7
    if (clean.startsWith('fe8') || clean.startsWith('fe9') || clean.startsWith('fea') || clean.startsWith('feb')) {
      return true; // fe80::/10 link-local
    }
    if (clean.startsWith('ff')) return true; // Multicast
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

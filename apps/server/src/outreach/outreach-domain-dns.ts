/**
 * 发信域 DNS 只读检查与记录模板（P4-12 工程部分）：SPF / DKIM / DMARC / MX。
 * 纯函数 + 注入的 DNS 解析器（node:dns/promises 或测试桩），不发任何写操作、不依赖第三方 API。
 */

export interface DnsMxRecord {
  exchange: string;
  priority: number;
}

export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolveMx(name: string): Promise<DnsMxRecord[]>;
}

export interface SpfReport {
  present: boolean;
  record: string | null;
  /** 结尾 qualifier（~all / -all / ?all），缺省为 null。 */
  qualifier: string | null;
}

export interface DmarcReport {
  present: boolean;
  record: string | null;
  policy: string | null;
  pct: number | null;
  hasRua: boolean;
}

export interface DkimReport {
  present: boolean;
  selector: string;
}

export interface DomainDnsReport {
  domain: string;
  mx: DnsMxRecord[];
  spf: SpfReport;
  dmarc: DmarcReport;
  dkim: DkimReport;
  ok: { spf: boolean; dmarc: boolean; dkim: boolean; mx: boolean };
  /** 是否达到「可发车」的最低 DNS 形态（四项全真）。 */
  ready: boolean;
}

async function safeTxt(resolver: DnsResolver, name: string): Promise<string[]> {
  try {
    const chunks = await resolver.resolveTxt(name);
    return chunks.map((parts) => parts.join(''));
  } catch {
    return [];
  }
}

async function safeMx(resolver: DnsResolver, name: string): Promise<DnsMxRecord[]> {
  try {
    return await resolver.resolveMx(name);
  } catch {
    return [];
  }
}

function inspectSpf(records: string[]): SpfReport {
  const record = records.find((value) => value.trim().startsWith('v=spf1')) ?? null;
  if (!record) return { present: false, record: null, qualifier: null };
  const qualifier = /([~\-?])all\b/.exec(record)?.[0] ?? null;
  return { present: true, record, qualifier };
}

function inspectDmarc(records: string[]): DmarcReport {
  const record = records.find((value) => value.trim().startsWith('v=DMARC1')) ?? null;
  if (!record) return { present: false, record: null, policy: null, pct: null, hasRua: false };
  return {
    present: true,
    record,
    policy: /(?:^|;)\s*p\s*=\s*(none|quarantine|reject)/i.exec(record)?.[1]?.toLowerCase() ?? null,
    pct: (() => {
      const matched = /(?:^|;)\s*pct\s*=\s*(\d{1,3})/i.exec(record)?.[1];
      return matched ? Number(matched) : null;
    })(),
    hasRua: /(?:^|;)\s*rua\s*=\s*mailto:/i.test(record),
  };
}

/** 检查一个发件域的必要 DNS 记录（只读）。 */
export async function inspectSenderDomain(
  domain: string,
  resolver: DnsResolver,
  options: { dkimSelector?: string } = {},
): Promise<DomainDnsReport> {
  const normalized = domain.trim().toLowerCase();
  const selector = options.dkimSelector ?? 'google';
  const [spfRecords, dmarcRecords, dkimRecords, mx] = await Promise.all([
    safeTxt(resolver, normalized),
    safeTxt(resolver, `_dmarc.${normalized}`),
    safeTxt(resolver, `${selector}._domainkey.${normalized}`),
    safeMx(resolver, normalized),
  ]);
  const spf = inspectSpf(spfRecords);
  const dmarc = inspectDmarc(dmarcRecords);
  const dkim: DkimReport = {
    present: dkimRecords.some((value) => value.trim().startsWith('v=DKIM1')),
    selector,
  };
  const ok = { spf: spf.present, dmarc: dmarc.present, dkim: dkim.present, mx: mx.length > 0 };
  return {
    domain: normalized,
    mx,
    spf,
    dmarc,
    dkim,
    ok,
    ready: ok.spf && ok.dmarc && ok.dkim && ok.mx,
  };
}

/** 生成该域的 DNS 记录模板（DMARC 阶段 1：p=none + rua；阶段 2/3 注释保留）。 */
export function dnsRecordTemplate(
  domain: string,
  options: { dkimSelector?: string } = {},
): string {
  const normalized = domain.trim().toLowerCase();
  const selector = options.dkimSelector ?? 'google';
  return [
    `; SPF（Google Workspace）`,
    `${normalized}.            TXT   "v=spf1 include:_spf.google.com ~all"`,
    `; DKIM（Admin 控制台生成 2048-bit，selector=${selector}）`,
    `${selector}._domainkey.${normalized}. TXT "v=DKIM1; k=rsa; p=<控制台生成值>"`,
    `; DMARC 阶段 1（前 3 周）：仅观测`,
    `_dmarc.${normalized}.     TXT   "v=DMARC1; p=none; rua=mailto:dmarc@${normalized}; ruf=mailto:dmarc-forensics@${normalized}; fo=1; adkim=r; aspf=r; pct=100"`,
    `; 阶段 2（第 3–4 周，门槛达标后）：隔离爬坡`,
    `; _dmarc.${normalized}.   TXT   "v=DMARC1; p=quarantine; rua=mailto:dmarc@${normalized}; adkim=s; aspf=s; pct=10"`,
    `; 阶段 3（第 5–6 周）：拒绝`,
    `; _dmarc.${normalized}.   TXT   "v=DMARC1; p=reject; rua=mailto:dmarc@${normalized}; adkim=s; aspf=s; pct=100"`,
    `; MX（Google Workspace）`,
    `${normalized}.            MX    1 smtp.google.com.`,
  ].join('\n');
}

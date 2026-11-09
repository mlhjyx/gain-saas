import { describe, expect, it } from 'vitest';
import {
  dnsRecordTemplate,
  inspectSenderDomain,
  type DnsMxRecord,
  type DnsResolver,
} from './outreach-domain-dns.js';

function fakeResolver(
  txt: Record<string, string[][]>,
  mx: Record<string, DnsMxRecord[]> = {},
): DnsResolver {
  return {
    resolveTxt: async (name) => {
      const records = txt[name];
      if (!records) throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
      return records;
    },
    resolveMx: async (name) => {
      const records = mx[name];
      if (!records) throw Object.assign(new Error(`queryMx ENODATA ${name}`), { code: 'ENODATA' });
      return records;
    },
  };
}

describe('inspectSenderDomain', () => {
  it('四项齐备时 ready=true，并解析 SPF qualifier 与 DMARC 策略', async () => {
    const resolver = fakeResolver(
      {
        'try-gainos.com': [['v=spf1 include:_spf.google.com ~all']],
        '_dmarc.try-gainos.com': [
          ['v=DMARC1; p=none; rua=mailto:dmarc@try-gainos.com; pct=100; adkim=r'],
        ],
        'google._domainkey.try-gainos.com': [['v=DKIM1; k=rsa; p=MIIBIjANBg']],
      },
      { 'try-gainos.com': [{ exchange: 'smtp.google.com', priority: 1 }] },
    );
    const report = await inspectSenderDomain('try-gainos.com', resolver);
    expect(report.ready).toBe(true);
    expect(report.ok).toEqual({ spf: true, dmarc: true, dkim: true, mx: true });
    expect(report.spf.qualifier).toBe('~all');
    expect(report.dmarc.policy).toBe('none');
    expect(report.dmarc.pct).toBe(100);
    expect(report.dmarc.hasRua).toBe(true);
    expect(report.dkim.selector).toBe('google');
    expect(report.mx).toEqual([{ exchange: 'smtp.google.com', priority: 1 }]);
  });

  it('TXT 分片按 RFC 拼接后再识别 SPF', async () => {
    const resolver = fakeResolver(
      {
        'try-gainos.com': [['v=spf1 include:_spf.', 'google.com -all']],
        '_dmarc.try-gainos.com': [['v=DMARC1; p=reject']],
        'google._domainkey.try-gainos.com': [['v=DKIM1; k=rsa; p=abc']],
      },
      { 'try-gainos.com': [{ exchange: 'smtp.google.com', priority: 1 }] },
    );
    const report = await inspectSenderDomain('try-gainos.com', resolver);
    expect(report.spf.present).toBe(true);
    expect(report.spf.record).toBe('v=spf1 include:_spf.google.com -all');
    expect(report.spf.qualifier).toBe('-all');
    expect(report.dmarc.hasRua).toBe(false);
  });

  it('缺 DMARC 时 ready=false，其余项不受影响', async () => {
    const resolver = fakeResolver(
      {
        'try-gainos.com': [['v=spf1 include:_spf.google.com ~all']],
        'google._domainkey.try-gainos.com': [['v=DKIM1; k=rsa; p=abc']],
      },
      { 'try-gainos.com': [{ exchange: 'smtp.google.com', priority: 1 }] },
    );
    const report = await inspectSenderDomain('try-gainos.com', resolver);
    expect(report.ready).toBe(false);
    expect(report.ok).toEqual({ spf: true, dmarc: false, dkim: true, mx: true });
    expect(report.dmarc).toEqual({ present: false, record: null, policy: null, pct: null, hasRua: false });
  });

  it('自定义 DKIM selector 查询对应记录名', async () => {
    const queried: string[] = [];
    const base = fakeResolver(
      {
        'try-gainos.com': [['v=spf1 ~all']],
        '_dmarc.try-gainos.com': [['v=DMARC1; p=none; rua=mailto:dmarc@try-gainos.com']],
        'selector1._domainkey.try-gainos.com': [['v=DKIM1; k=rsa; p=abc']],
      },
      { 'try-gainos.com': [{ exchange: 'mx.example.net', priority: 10 }] },
    );
    const resolver: DnsResolver = {
      resolveTxt: (name) => {
        queried.push(name);
        return base.resolveTxt(name);
      },
      resolveMx: (name) => base.resolveMx(name),
    };
    const report = await inspectSenderDomain('try-gainos.com', resolver, { dkimSelector: 'selector1' });
    expect(queried).toContain('selector1._domainkey.try-gainos.com');
    expect(queried).not.toContain('google._domainkey.try-gainos.com');
    expect(report.dkim.present).toBe(true);
    expect(report.dkim.selector).toBe('selector1');
    expect(report.ready).toBe(true);
  });

  it('解析失败（NXDOMAIN 等）按缺失处理而不抛错，域名统一小写查询', async () => {
    const resolver = fakeResolver({});
    const report = await inspectSenderDomain('  Try-GainOS.COM ', resolver);
    expect(report.domain).toBe('try-gainos.com');
    expect(report.ready).toBe(false);
    expect(report.ok).toEqual({ spf: false, dmarc: false, dkim: false, mx: false });
    expect(report.mx).toEqual([]);
  });
});

describe('dnsRecordTemplate', () => {
  it('包含 SPF / DKIM / DMARC（阶段 1 生效）与 MX 记录，域名正确代入', () => {
    const template = dnsRecordTemplate('try-gainos.com');
    expect(template).toContain('try-gainos.com.            TXT   "v=spf1 include:_spf.google.com ~all"');
    expect(template).toContain('google._domainkey.try-gainos.com. TXT "v=DKIM1; k=rsa; p=<控制台生成值>"');
    expect(template).toContain('_dmarc.try-gainos.com.     TXT   "v=DMARC1; p=none; rua=mailto:dmarc@try-gainos.com');
    expect(template).toContain('try-gainos.com.            MX    1 smtp.google.com.');
    // 阶段 2/3 以注释保留，不生效
    const activeDmarcLines = template
      .split('\n')
      .filter((line) => line.includes('v=DMARC1') && !line.trimStart().startsWith(';'));
    expect(activeDmarcLines).toHaveLength(1);
    expect(activeDmarcLines[0]).toContain('p=none');
  });

  it('自定义 selector 时 DKIM 记录名随之变化', () => {
    const template = dnsRecordTemplate('gainos-outreach.com', { dkimSelector: 'selector2' });
    expect(template).toContain('selector2._domainkey.gainos-outreach.com.');
    expect(template).not.toContain('google._domainkey');
  });
});

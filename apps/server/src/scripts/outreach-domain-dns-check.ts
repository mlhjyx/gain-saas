import '../shared/load-env.js';
/**
 * P4-12：发信域 DNS 只读检查 + 记录模板（零成本、无写操作）。
 *
 * 用法（cwd=apps/server）：
 *   pnpm exec tsx src/scripts/outreach-domain-dns-check.ts try-gainos.com gainos-outreach.com
 *   pnpm exec tsx src/scripts/outreach-domain-dns-check.ts --template try-gainos.com
 *   OUTREACH_DNS_CHECK_DOMAINS=a.com,b.com pnpm exec tsx src/scripts/outreach-domain-dns-check.ts
 *
 * 输出：检查模式打印 JSON 报告（每域 SPF/DKIM/DMARC/MX 与 ready），任一域未就绪退出码 2；
 *       --template 模式打印可直接粘贴到 DNS 服务商的记录模板（退出码 0）。
 */
import { resolveMx, resolveTxt } from 'node:dns/promises';
import {
  dnsRecordTemplate,
  inspectSenderDomain,
} from '../outreach/outreach-domain-dns.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const templateMode = args.includes('--template');
  const cliDomains = args.filter((value) => !value.startsWith('--'));
  const envDomains = (process.env.OUTREACH_DNS_CHECK_DOMAINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const domains = [...new Set([...cliDomains, ...envDomains])];
  if (domains.length === 0) {
    console.error('用法: tsx src/scripts/outreach-domain-dns-check.ts [--template] <domain...>');
    process.exitCode = 1;
    return;
  }
  const resolver = { resolveTxt, resolveMx };
  if (templateMode) {
    console.log(domains.map((domain) => dnsRecordTemplate(domain)).join('\n\n'));
    return;
  }
  const reports = [];
  for (const domain of domains) {
    reports.push(await inspectSenderDomain(domain, resolver));
  }
  console.log(JSON.stringify({ reports }, null, 2));
  process.exitCode = reports.every((report) => report.ready) ? 0 : 2;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});

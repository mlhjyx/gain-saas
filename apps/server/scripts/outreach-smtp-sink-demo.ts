/**
 * TEST-ONLY 本地 SMTP sink 演示（M2 步 11-3）。
 * 只允许回环地址：OUTREACH_SMTP_ALLOWED_HOSTS 固定 127.0.0.1，发送开关由调用方显式打开。
 * 用法见 docs/evidence/outreach-11-3/README.md；绝不连接外网 SMTP。
 */
import { readFileSync } from 'node:fs';
import type { AppConfig } from '../src/config/configuration.js';
import { SmtpOutreachTransport } from '../src/outreach/outreach-smtp.transport.js';

const host = process.env.OUTREACH_SMTP_HOST ?? '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  throw new Error(`演示只允许本机 sink，拒绝 ${host}`);
}

const privateKeyPath = process.env.OUTREACH_DKIM_PRIVATE_KEY_PATH;
if (!privateKeyPath) throw new Error('缺少 OUTREACH_DKIM_PRIVATE_KEY_PATH');
const privateKeyPem = readFileSync(privateKeyPath, 'utf8');

const config = {
  OUTREACH_SMTP_HOST: host,
  OUTREACH_SMTP_PORT: Number(process.env.OUTREACH_SMTP_PORT ?? 11025),
  OUTREACH_SMTP_SECURE: false,
  OUTREACH_SMTP_STARTTLS: false,
  OUTREACH_SMTP_FROM_ADDRESS: process.env.OUTREACH_SMTP_FROM_ADDRESS ?? 'outreach@mail.gainos.test',
  OUTREACH_SMTP_FROM_NAME: process.env.OUTREACH_SMTP_FROM_NAME ?? 'GainOS TEST',
  OUTREACH_SMTP_TLS_REJECT_UNAUTHORIZED: true,
  OUTREACH_SMTP_TIMEOUT_MS: 15_000,
  OUTREACH_SMTP_ALLOWED_HOSTS: '127.0.0.1',
  OUTREACH_DKIM_REQUIRED: true,
  OUTREACH_DKIM_DOMAIN: process.env.OUTREACH_DKIM_DOMAIN ?? 'mail.gainos.test',
  OUTREACH_DKIM_SELECTOR: process.env.OUTREACH_DKIM_SELECTOR ?? 'test20261108',
  OUTREACH_DKIM_PRIVATE_KEY: privateKeyPem,
} as AppConfig;

async function main(): Promise<void> {
  const transport = new SmtpOutreachTransport(config);
  const result = await transport.send({
    to: process.env.OUTREACH_DEMO_TO ?? 'buyer@example.test',
    subject: 'TEST – GainOS 触达链路本地投递',
    body: [
      'Dies ist eine TEST-Nachricht an einen lokalen SMTP-Sink.',
      'Keine echte Zustellung. Bitte ignorieren.',
      '',
      'GainOS M2 Step 11-3 local sink evidence.',
    ].join('\r\n'),
  });
  console.log(
    JSON.stringify({
      ok: true,
      messageId: result.messageId,
      host,
      port: config.OUTREACH_SMTP_PORT,
    }),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

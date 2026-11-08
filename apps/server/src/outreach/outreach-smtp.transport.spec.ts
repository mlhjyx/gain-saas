import { createHash, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import {
  canonicalizeDkimBody,
  canonicalizeDkimHeader,
} from './outreach-dkim.js';
import { SmtpOutreachTransport } from './outreach-smtp.transport.js';

/**
 * TEST-ONLY：进程内 SMTP sink，模拟最小 ESMTP 会话，捕获 DATA 原文。
 * 不连接任何真实 SMTP、不投递邮件；真实本地 sink（Mailpit）演示见 docs/evidence/outreach-11-3。
 */
class TestSmtpSink {
  server!: Server;
  port = 0;
  received: string[] = [];

  async start(): Promise<void> {
    this.server = createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.port = (this.server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(socket: Socket): void {
    let buffer = '';
    let inData = false;
    let current = '';
    socket.write('220 test-sink ESMTP\r\n');
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      while (true) {
        const newline = buffer.indexOf('\r\n');
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            this.received.push(current);
            current = '';
            socket.write('250 2.0.0 queued as TEST\r\n');
          } else {
            current += `${line}\r\n`;
          }
          continue;
        }
        const command = line.toUpperCase();
        if (command.startsWith('EHLO') || command.startsWith('HELO')) {
          socket.write('250-test-sink\r\n250 HELP\r\n');
        } else if (command.startsWith('MAIL FROM') || command.startsWith('RCPT TO')) {
          socket.write('250 2.1.0 ok\r\n');
        } else if (command === 'DATA') {
          inData = true;
          socket.write('354 end with <CRLF>.<CRLF>\r\n');
        } else if (command === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          socket.write('250 ok\r\n');
        }
      }
    });
  }
}

function parseDkim(message: string): {
  headerValue: string;
  headers: Map<string, string>;
  body: string;
} {
  const separator = message.indexOf('\r\n\r\n');
  const headerBlock = message.slice(0, separator);
  const body = message.slice(separator + 4);
  const headers = new Map<string, string>();
  for (const line of headerBlock.split('\r\n')) {
    const colon = line.indexOf(':');
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headerValue: headers.get('dkim-signature')!, headers, body };
}

function base64Sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64');
}

function verifyDkim(message: string, publicKeyPem: string): boolean {
  const { headerValue, headers, body } = parseDkim(message);
  const tags = new Map<string, string>();
  for (const part of headerValue.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    tags.set(key, rest.join('='));
  }
  expect(tags.get('v')).toBe('1');
  expect(tags.get('a')).toBe('rsa-sha256');
  expect(tags.get('c')).toBe('relaxed/relaxed');
  expect(tags.get('bh')).toBe(base64Sha256(canonicalizeDkimBody(body)));

  const signedNames = tags.get('h')!.split(':');
  const unsignedValue = headerValue.replace(/b=[^;]*$/, 'b=');
  const signingInput =
    signedNames
      .map((name) => canonicalizeDkimHeader(name, headers.get(name)!))
      .join('') + canonicalizeDkimHeader('DKIM-Signature', unsignedValue).slice(0, -2);
  return cryptoVerify(
    'sha256',
    Buffer.from(signingInput, 'utf8'),
    publicKeyPem,
    Buffer.from(tags.get('b')!, 'base64'),
  );
}

describe('SmtpOutreachTransport（TEST-only 进程内 sink）', () => {
  const sink = new TestSmtpSink();
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  beforeAll(async () => {
    await sink.start();
  });
  afterAll(async () => {
    await sink.stop();
  });

  function transport(overrides: Partial<AppConfig> = {}): SmtpOutreachTransport {
    const config = {
      OUTREACH_SMTP_HOST: '127.0.0.1',
      OUTREACH_SMTP_PORT: sink.port,
      OUTREACH_SMTP_SECURE: false,
      OUTREACH_SMTP_STARTTLS: false,
      OUTREACH_SMTP_FROM_ADDRESS: 'outreach@mail.gainos.test',
      OUTREACH_SMTP_FROM_NAME: 'GainOS TEST',
      OUTREACH_SMTP_TLS_REJECT_UNAUTHORIZED: true,
      OUTREACH_SMTP_TIMEOUT_MS: 5000,
      OUTREACH_SMTP_ALLOWED_HOSTS: '127.0.0.1',
      OUTREACH_DKIM_REQUIRED: true,
      OUTREACH_DKIM_DOMAIN: 'mail.gainos.test',
      OUTREACH_DKIM_SELECTOR: 'test20261108',
      OUTREACH_DKIM_PRIVATE_KEY: privateKeyPem,
      ...overrides,
    } as AppConfig;
    return new SmtpOutreachTransport(config);
  }

  it('投递到本地 sink，且 DKIM relaxed/rsa-sha256 签名可验证', async () => {
    const result = await transport().send({
      to: 'buyer@example.test',
      subject: 'TEST – DKIM 本地验证',
      body: 'Dies ist ein TEST. Keine echte Mail.',
    });

    expect(result.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sink.received).toHaveLength(1);
    const raw = sink.received[0];
    expect(raw).toContain('To: <buyer@example.test>');
    expect(raw).toContain('Subject: =?UTF-8?B?');
    expect(raw).toContain('DKIM-Signature: v=1');
    expect(verifyDkim(raw, publicKeyPem)).toBe(true);
  });

  it('负向：出口不在白名单时拒绝，连不上任何 SMTP', async () => {
    const guarded = transport({ OUTREACH_SMTP_ALLOWED_HOSTS: 'localhost' });
    await expect(
      guarded.send({
        to: 'buyer@example.test',
        subject: 'TEST',
        body: 'TEST',
      }),
    ).rejects.toThrow(/不在白名单/);
    expect(sink.received).toHaveLength(1);
  });

  it('负向：DKIM 缺失时默认拒绝发送', async () => {
    const unsigned = transport({
      OUTREACH_DKIM_DOMAIN: undefined,
      OUTREACH_DKIM_SELECTOR: undefined,
      OUTREACH_DKIM_PRIVATE_KEY: undefined,
      OUTREACH_DKIM_PRIVATE_KEY_PATH: undefined,
    });
    await expect(
      unsigned.send({
        to: 'buyer@example.test',
        subject: 'TEST',
        body: 'TEST',
      }),
    ).rejects.toThrow(/DKIM 未配置/);
    expect(sink.received).toHaveLength(1);
  });
});

import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { AppConfig } from '../config/configuration.js';
import { APP_CONFIG } from '../shared/config.module.js';
import { signDkimMessage, type DkimSigningOptions } from './outreach-dkim.js';

export interface OutreachMailMessage {
  to: string;
  subject: string;
  body: string;
  /** 附加头（如 List-Unsubscribe）；名称/值会清洗 CRLF。 */
  headers?: Record<string, string>;
}

export interface OutreachTransport {
  /** 配置缺失时抛错；调用方在写入任何失败台账前先调用，避免把配置问题记成逐封失败。 */
  ensureConfigured(): void;
  send(message: OutreachMailMessage): Promise<{ messageId: string }>;
}

export const OUTREACH_TRANSPORT = Symbol('OUTREACH_TRANSPORT');

class SmtpProtocolError extends Error {
  constructor(
    readonly step: string,
    readonly response: string[],
  ) {
    super(`SMTP ${step} 被拒绝：${response.join(' | ')}`);
    this.name = 'SmtpProtocolError';
  }
}

/**
 * 极简 SMTP 客户端：EHLO → STARTTLS（默认强制）→ AUTH（可选）→ MAIL/RCPT/DATA。
 * 只发纯文本单收件人邮件；不实现附件、HTML、批量。
 */
class SmtpSession {
  private buffer = '';
  private readonly waiters: Array<{
    resolve: (lines: string[]) => void;
    reject: (error: Error) => void;
  }> = [];
  private failure: Error | null = null;

  private readonly onData = (chunk: Buffer | string) => {
    this.buffer += chunk.toString();
    this.drain();
  };
  private readonly onError = (error: Error) => this.fail(error);
  private readonly onClose = () => this.fail(new Error('SMTP 连接已关闭'));

  constructor(
    private socket: Socket,
    timeoutMs: number,
  ) {
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => this.fail(new Error('SMTP 响应超时')));
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  static connect(
    host: string,
    port: number,
    secure: boolean,
    rejectUnauthorized: boolean,
    timeoutMs: number,
  ): Promise<SmtpSession> {
    return new Promise((resolve, reject) => {
      const socket = secure
        ? tlsConnect({ host, port, servername: host, rejectUnauthorized })
        : netConnect({ host, port });
      const readyEvent = secure ? 'secureConnect' : 'connect';
      socket.once(readyEvent, () => {
        socket.setTimeout(0);
        resolve(new SmtpSession(socket, timeoutMs));
      });
      socket.once('error', reject);
      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error('SMTP 连接超时'));
      });
    });
  }

  async upgrade(
    host: string,
    rejectUnauthorized: boolean,
    timeoutMs: number,
  ): Promise<SmtpSession> {
    const raw = this.socket;
    this.detach();
    raw.removeAllListeners('timeout');
    return new Promise((resolve, reject) => {
      const secureSocket = tlsConnect(
        { socket: raw, servername: host, rejectUnauthorized },
        () => {
          secureSocket.setTimeout(0);
          resolve(new SmtpSession(secureSocket, timeoutMs));
        },
      );
      secureSocket.once('error', reject);
      secureSocket.once('timeout', () => {
        secureSocket.destroy();
        reject(new Error('SMTP TLS 握手超时'));
      });
    });
  }

  send(command: string): void {
    this.socket.write(`${command}\r\n`);
  }

  sendRaw(payload: string): void {
    this.socket.write(payload);
  }

  async expect(codes: readonly number[], step: string): Promise<string[]> {
    const lines = await this.nextResponse();
    const finalLine = lines[lines.length - 1] ?? '';
    const code = Number(finalLine.slice(0, 3));
    if (!codes.includes(code)) {
      throw new SmtpProtocolError(step, lines);
    }
    return lines;
  }

  close(): void {
    this.detach();
    this.socket.destroy();
  }

  private detach(): void {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
  }

  private nextResponse(): Promise<string[]> {
    if (this.failure) return Promise.reject(this.failure);
    const ready = this.extractResponse();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const ready = this.extractResponse();
      if (!ready) return;
      this.waiters.shift()!.resolve(ready);
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    while (this.waiters.length > 0) {
      this.waiters.shift()!.reject(error);
    }
  }

  /** 取出一条完整 SMTP 响应：最后一行形如 `250 ...`，续行是 `250-...`。 */
  private extractResponse(): string[] | null {
    const lines: string[] = [];
    let offset = 0;
    while (true) {
      const newline = this.buffer.indexOf('\r\n', offset);
      if (newline === -1) return null;
      const line = this.buffer.slice(offset, newline);
      offset = newline + 2;
      if (!/^\d{3}[ -]/.test(line)) {
        continue;
      }
      lines.push(line);
      if (line[3] === ' ') {
        this.buffer = this.buffer.slice(offset);
        return lines;
      }
    }
  }
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function encodeHeaderValue(value: string): string {
  const clean = sanitizeHeader(value);
  // ASCII 可打印字符直接放；其余一律 RFC 2047 encoded-word，避免裸 UTF-8 头。
  return /^[\x20-\x7e]*$/.test(clean)
    ? clean
    : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

export function buildMimeMessage(input: {
  fromAddress: string;
  fromName: string;
  to: string;
  subject: string;
  body: string;
  messageId: string;
  date: Date;
  headers?: Record<string, string>;
}): string {
  const domain = input.fromAddress.split('@')[1] || 'localhost';
  const from = input.fromName
    ? `${encodeHeaderValue(input.fromName)} <${sanitizeHeader(input.fromAddress)}>`
    : `<${sanitizeHeader(input.fromAddress)}>`;
  const encodedBody = Buffer.from(input.body, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
  const extraHeaders = Object.entries(input.headers ?? {}).map(
    ([name, value]) => `${sanitizeHeader(name)}: ${sanitizeHeader(value)}`,
  );
  return [
    `From: ${from}`,
    `To: <${sanitizeHeader(input.to)}>`,
    `Subject: ${encodeHeaderValue(input.subject)}`,
    `Date: ${input.date.toUTCString()}`,
    `Message-ID: <${input.messageId}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    ...extraHeaders,
    '',
    encodedBody,
  ].join('\r\n');
}

/**
 * SMTP 出口（M2 步 11-3）。默认配置下 host 为空 → ensureConfigured 抛错，执行器无法发送。
 * 发送总开关不在这里，而在 OutreachSendGate（OUTREACH_SEND_ENABLED=false 时根本不会到达本类）。
 */
@Injectable()
export class SmtpOutreachTransport implements OutreachTransport {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  ensureConfigured(): void {
    if (!this.config.OUTREACH_SMTP_HOST || !this.config.OUTREACH_SMTP_FROM_ADDRESS) {
      throw new Error(
        'SMTP 出口未配置（OUTREACH_SMTP_HOST / OUTREACH_SMTP_FROM_ADDRESS），拒绝发送',
      );
    }
    const allowed = this.config.OUTREACH_SMTP_ALLOWED_HOSTS.split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
    if (!allowed.includes(this.config.OUTREACH_SMTP_HOST.toLowerCase())) {
      throw new Error(
        `SMTP 出口 ${this.config.OUTREACH_SMTP_HOST} 不在白名单（OUTREACH_SMTP_ALLOWED_HOSTS），拒绝发送`,
      );
    }
    this.dkimOptions();
  }

  private dkimOptions(): DkimSigningOptions | null {
    const config = this.config;
    const configured = Boolean(
      config.OUTREACH_DKIM_DOMAIN ||
        config.OUTREACH_DKIM_SELECTOR ||
        config.OUTREACH_DKIM_PRIVATE_KEY ||
        config.OUTREACH_DKIM_PRIVATE_KEY_PATH,
    );
    if (!configured && !config.OUTREACH_DKIM_REQUIRED) return null;
    if (!config.OUTREACH_DKIM_DOMAIN || !config.OUTREACH_DKIM_SELECTOR) {
      throw new Error('DKIM 未配置（OUTREACH_DKIM_DOMAIN / OUTREACH_DKIM_SELECTOR），拒绝发送');
    }
    let privateKeyPem = config.OUTREACH_DKIM_PRIVATE_KEY?.replace(/\\n/g, '\n');
    if (!privateKeyPem && config.OUTREACH_DKIM_PRIVATE_KEY_PATH) {
      privateKeyPem = readFileSync(config.OUTREACH_DKIM_PRIVATE_KEY_PATH, 'utf8');
    }
    if (!privateKeyPem) {
      throw new Error('DKIM 缺少私钥（OUTREACH_DKIM_PRIVATE_KEY 或 _PATH），拒绝发送');
    }
    return {
      domain: config.OUTREACH_DKIM_DOMAIN,
      selector: config.OUTREACH_DKIM_SELECTOR,
      privateKeyPem,
    };
  }

  async send(message: OutreachMailMessage): Promise<{ messageId: string }> {
    this.ensureConfigured();
    const dkim = this.dkimOptions();
    const config = this.config;
    const host = config.OUTREACH_SMTP_HOST!;
    const fromAddress = config.OUTREACH_SMTP_FROM_ADDRESS!;
    const timeoutMs = config.OUTREACH_SMTP_TIMEOUT_MS;
    const messageId = randomUUID();

    let session = await SmtpSession.connect(
      host,
      config.OUTREACH_SMTP_PORT,
      config.OUTREACH_SMTP_SECURE,
      config.OUTREACH_SMTP_TLS_REJECT_UNAUTHORIZED,
      timeoutMs,
    );
    try {
      await session.expect([220], 'greeting');
      const hostname = 'gain-saas.local';
      session.send(`EHLO ${hostname}`);
      let extensions = (await session.expect([250], 'EHLO')).join('\n');

      if (!config.OUTREACH_SMTP_SECURE && config.OUTREACH_SMTP_STARTTLS) {
        if (!/STARTTLS/i.test(extensions)) {
          throw new Error('SMTP 服务器未提供 STARTTLS，拒绝明文发送');
        }
        session.send('STARTTLS');
        await session.expect([220], 'STARTTLS');
        session = await session.upgrade(
          host,
          config.OUTREACH_SMTP_TLS_REJECT_UNAUTHORIZED,
          timeoutMs,
        );
        session.send(`EHLO ${hostname}`);
        extensions = (await session.expect([250], 'EHLO')).join('\n');
      }

      if (config.OUTREACH_SMTP_USER && config.OUTREACH_SMTP_PASSWORD) {
        if (/AUTH[^\n]*PLAIN/i.test(extensions)) {
          const token = Buffer.from(
            `\0${config.OUTREACH_SMTP_USER}\0${config.OUTREACH_SMTP_PASSWORD}`,
            'utf8',
          ).toString('base64');
          session.send(`AUTH PLAIN ${token}`);
          await session.expect([235], 'AUTH');
        } else if (/AUTH/i.test(extensions)) {
          session.send('AUTH LOGIN');
          await session.expect([334], 'AUTH LOGIN');
          session.send(Buffer.from(config.OUTREACH_SMTP_USER, 'utf8').toString('base64'));
          await session.expect([334], 'AUTH user');
          session.send(Buffer.from(config.OUTREACH_SMTP_PASSWORD, 'utf8').toString('base64'));
          await session.expect([235], 'AUTH password');
        } else {
          throw new Error('SMTP 服务器不支持 AUTH，拒绝发送未认证邮件');
        }
      }

      session.send(`MAIL FROM:<${sanitizeHeader(fromAddress)}>`);
      await session.expect([250], 'MAIL FROM');
      session.send(`RCPT TO:<${sanitizeHeader(message.to)}>`);
      await session.expect([250, 251], 'RCPT TO');
      session.send('DATA');
      await session.expect([354], 'DATA');

      let mime = buildMimeMessage({
        fromAddress,
        fromName: config.OUTREACH_SMTP_FROM_NAME,
        to: message.to,
        subject: message.subject,
        body: message.body,
        messageId,
        date: new Date(),
        headers: message.headers,
      });
      if (dkim) {
        mime = signDkimMessage(mime, dkim);
      }
      session.sendRaw(`${mime}\r\n.\r\n`);
      await session.expect([250], 'DATA body');
      return { messageId };
    } finally {
      session.close();
    }
  }
}

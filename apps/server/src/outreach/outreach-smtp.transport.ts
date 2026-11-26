import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { AppConfig } from '../config/configuration.js';
import { APP_CONFIG } from '../shared/config.module.js';
import { signDkimMessage, type DkimSigningOptions } from './outreach-dkim.js';
import { resolveAndAssertSafeMailHost } from './outreach-host-guard.js';
import type { MailboxAuthMode } from './outreach-pii.constants.js';

export interface OutreachMailMessage {
  to: string;
  subject: string;
  body: string;
  /** 附加头（如 List-Unsubscribe）；名称/值会清洗 CRLF。 */
  headers?: Record<string, string>;
}

/** 单租户 BYO 发信箱动态连接凭据（内存中解密后传入，绝不落日志）。 */
export interface OutreachSmtpCredentials {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly starttls?: boolean;
  readonly fromAddress: string;
  readonly fromName: string;
  readonly authMode: MailboxAuthMode;
  readonly user?: string;
  readonly password?: string;
  readonly accessToken?: string;
  readonly timeoutMs?: number;
  readonly rejectUnauthorized?: boolean;
}

export interface SmtpConnectionTestResult {
  readonly ok: true;
  readonly latencyMs: number;
  readonly authMode: MailboxAuthMode;
}

export interface OutreachTransport {
  /** 配置缺失时抛错；调用方在写入任何失败台账前先调用，避免把配置问题记成逐封失败。 */
  ensureConfigured(credentials?: OutreachSmtpCredentials): void;
  send(
    message: OutreachMailMessage,
    credentials?: OutreachSmtpCredentials,
  ): Promise<{ messageId: string }>;
  testConnection?(credentials: OutreachSmtpCredentials): Promise<SmtpConnectionTestResult>;
}

export const OUTREACH_TRANSPORT = Symbol('OUTREACH_TRANSPORT');

export class SmtpProtocolError extends Error {
  constructor(
    readonly step: string,
    readonly response: string[],
  ) {
    super(`SMTP ${step} 被拒绝：${response.join(' | ')}`);
    this.name = 'SmtpProtocolError';
  }
}

export interface SmtpFailureTelemetry {
  smtpStatusCode: number | null;
  smtpResponse: string | null;
  /** HARD=5xx 永久拒绝（地址不存在/被拒收）；SOFT=4xx、超时、网络（可重试）。 */
  bounceType: 'HARD' | 'SOFT' | null;
}

/**
 * 把发送失败归类为可落库的遥测（P4-04）：协议层 5xx 记 HARD，4xx 与网络/超时记 SOFT；
 * 非协议错误（配置/签名等）记 SOFT 但多半会在更早的门被拦下。
 */
export function smtpFailureTelemetry(error: unknown): SmtpFailureTelemetry {
  if (error instanceof SmtpProtocolError) {
    const lastLine = error.response[error.response.length - 1] ?? '';
    const code = Number(lastLine.slice(0, 3));
    const valid = Number.isInteger(code) && code >= 100 && code <= 599;
    return {
      smtpStatusCode: valid ? code : null,
      smtpResponse: error.response.join(' | ').slice(0, 500),
      bounceType: valid ? (code >= 500 ? 'HARD' : code >= 400 ? 'SOFT' : null) : null,
    };
  }
  return {
    smtpStatusCode: null,
    smtpResponse: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    bounceType: 'SOFT',
  };
}

/** 构造 RFC 7628 / Google / M365 标准 XOAUTH2 SASL 令牌。 */
export function buildXoauth2Token(user: string, accessToken: string): string {
  return Buffer.from(`user=${user}\x01auth=Bearer ${accessToken}\x01\x01`, 'utf8').toString('base64');
}

/**
 * 极简 SMTP 客户端：EHLO → STARTTLS（默认强制）→ AUTH（PLAIN / LOGIN / XOAUTH2）→ MAIL/RCPT/DATA。
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
    connectHost: string,
    tlsServername: string,
    port: number,
    secure: boolean,
    rejectUnauthorized: boolean,
    timeoutMs: number,
  ): Promise<SmtpSession> {
    return new Promise((resolve, reject) => {
      const socket = secure
        ? tlsConnect({ host: connectHost, port, servername: tlsServername, rejectUnauthorized })
        : netConnect({ host: connectHost, port });
      socket.setTimeout(timeoutMs);
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
    tlsServername: string,
    rejectUnauthorized: boolean,
    timeoutMs: number,
  ): Promise<SmtpSession> {
    const raw = this.socket;
    this.detach();
    raw.removeAllListeners('timeout');
    return new Promise((resolve, reject) => {
      const secureSocket = tlsConnect(
        { socket: raw, servername: tlsServername, rejectUnauthorized },
        () => {
          secureSocket.setTimeout(0);
          resolve(new SmtpSession(secureSocket, timeoutMs));
        },
      );
      secureSocket.setTimeout(timeoutMs);
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

function assertSafeEnvelopeAddress(address: string, label: string): string {
  const clean = address.trim();
  if (!clean || /[<>\r\n\s]/.test(clean) || !clean.includes('@')) {
    throw new Error(`SMTP ${label} 地址不合法（禁止包含 <> 或空白）`);
  }
  return clean;
}

function resolveEhloFqdn(fromAddress: string): string {
  const domain = (fromAddress.split('@')[1] ?? '').trim().toLowerCase();
  if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    return domain;
  }
  return 'mail.localdomain';
}

function encodeHeaderValue(value: string): string {
  const clean = sanitizeHeader(value);
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
  /** 完整 Message-ID（含 @domain，不带尖括号）：必须与台账 outreach_send.messageId 一致，回信归因依赖它。 */
  messageId: string;
  date: Date;
  headers?: Record<string, string>;
}): string {
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
    `Message-ID: <${input.messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    ...extraHeaders,
    '',
    encodedBody,
  ].join('\r\n');
}

/**
 * 多租户 BYO + 兼容出口 SMTP 传输层（M9-PR2）：
 * - 优先使用调用方传入的租户 BYO 解密凭据（支持密码 PLAIN/LOGIN 与 Google/M365 XOAUTH2）；
 * - 强制 SSRF 校验（禁止连接内网/回环/元数据地址）与 STARTTLS/TLS；
 * - 未传入 BYO 凭据时兼容旧 env 配置路径。
 */
@Injectable()
export class SmtpOutreachTransport implements OutreachTransport {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  ensureConfigured(credentials?: OutreachSmtpCredentials): void {
    if (credentials) {
      if (!credentials.host || !credentials.fromAddress) {
        throw new Error('BYO 发信箱缺少 SMTP 主机或发件地址，拒绝发送');
      }
      if (credentials.authMode === 'password') {
        if (!credentials.user || !credentials.password) {
          throw new Error('BYO 发信箱密码模式缺少用户名或密码，拒绝发送');
        }
      } else if (!credentials.user || !credentials.accessToken) {
        throw new Error('BYO 发信箱 OAuth2 令牌缺失或已失效，请重新授权');
      }
      return;
    }

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

  private resolveEffectiveCredentials(override?: OutreachSmtpCredentials): {
    effective: OutreachSmtpCredentials;
    isByo: boolean;
  } {
    if (override) {
      return { effective: override, isByo: true };
    }
    return {
      isByo: false,
      effective: {
        host: this.config.OUTREACH_SMTP_HOST!,
        port: this.config.OUTREACH_SMTP_PORT,
        secure: this.config.OUTREACH_SMTP_SECURE,
        starttls: this.config.OUTREACH_SMTP_STARTTLS,
        fromAddress: this.config.OUTREACH_SMTP_FROM_ADDRESS!,
        fromName: this.config.OUTREACH_SMTP_FROM_NAME,
        authMode: 'password',
        user: this.config.OUTREACH_SMTP_USER,
        password: this.config.OUTREACH_SMTP_PASSWORD,
        timeoutMs: this.config.OUTREACH_SMTP_TIMEOUT_MS,
        rejectUnauthorized: this.config.OUTREACH_SMTP_TLS_REJECT_UNAUTHORIZED,
      },
    };
  }

  private async openAuthenticatedSession(
    creds: OutreachSmtpCredentials,
    isByo: boolean,
  ): Promise<{ session: SmtpSession; fromAddress: string }> {
    const fromAddress = assertSafeEnvelopeAddress(creds.fromAddress, 'MAIL FROM');
    const timeoutMs = creds.timeoutMs ?? this.config.OUTREACH_SMTP_TIMEOUT_MS ?? 15_000;
    const rejectUnauthorized =
      creds.rejectUnauthorized ?? this.config.OUTREACH_SMTP_TLS_REJECT_UNAUTHORIZED ?? true;
    const starttls = creds.starttls ?? true;
    const ehloHostname = resolveEhloFqdn(fromAddress);

    let connectHost = creds.host;
    if (isByo) {
      const checked = await resolveAndAssertSafeMailHost(creds.host, creds.port, 'smtp', {
        allowPrivate: this.config.OUTREACH_BYO_ALLOW_PRIVATE_HOSTS === true,
      });
      connectHost = checked.resolvedAddress ?? checked.host;
    }

    let session = await SmtpSession.connect(
      connectHost,
      creds.host,
      creds.port,
      creds.secure,
      rejectUnauthorized,
      timeoutMs,
    );
    try {
      await session.expect([220], 'greeting');
      session.send(`EHLO ${ehloHostname}`);
      let extensions = (await session.expect([250], 'EHLO')).join('\n');

      if (!creds.secure && starttls) {
        if (!/STARTTLS/i.test(extensions)) {
          throw new Error('SMTP 服务器未提供 STARTTLS，拒绝明文发送');
        }
        session.send('STARTTLS');
        await session.expect([220], 'STARTTLS');
        session = await session.upgrade(creds.host, rejectUnauthorized, timeoutMs);
        session.send(`EHLO ${ehloHostname}`);
        extensions = (await session.expect([250], 'EHLO')).join('\n');
      }

      if (creds.authMode === 'oauth_google' || creds.authMode === 'oauth_m365') {
        if (!creds.user || !creds.accessToken) {
          throw new Error('OAuth2 发信缺少用户名或访问令牌');
        }
        if (!/AUTH[^\n]*XOAUTH2/i.test(extensions)) {
          throw new Error('SMTP 服务器未声明支持 AUTH XOAUTH2');
        }
        const xoauth2 = buildXoauth2Token(creds.user, creds.accessToken);
        session.send(`AUTH XOAUTH2 ${xoauth2}`);
        await session.expect([235], 'AUTH XOAUTH2');
      } else if (creds.user && creds.password) {
        if (/AUTH[^\n]*PLAIN/i.test(extensions)) {
          const token = Buffer.from(`\0${creds.user}\0${creds.password}`, 'utf8').toString('base64');
          session.send(`AUTH PLAIN ${token}`);
          await session.expect([235], 'AUTH');
        } else if (/AUTH/i.test(extensions)) {
          session.send('AUTH LOGIN');
          await session.expect([334], 'AUTH LOGIN');
          session.send(Buffer.from(creds.user, 'utf8').toString('base64'));
          await session.expect([334], 'AUTH user');
          session.send(Buffer.from(creds.password, 'utf8').toString('base64'));
          await session.expect([235], 'AUTH password');
        } else {
          throw new Error('SMTP 服务器不支持 AUTH，拒绝发送未认证邮件');
        }
      }

      return { session, fromAddress };
    } catch (err) {
      session.close();
      throw err;
    }
  }

  /** 连通性与认证自检：执行 TCP/TLS/EHLO/STARTTLS/AUTH/QUIT，不发任何测试邮件。 */
  async testConnection(credentials: OutreachSmtpCredentials): Promise<SmtpConnectionTestResult> {
    this.ensureConfigured(credentials);
    const startedAt = Date.now();
    const { session } = await this.openAuthenticatedSession(credentials, true);
    try {
      try {
        session.send('QUIT');
        await session.expect([221], 'QUIT');
      } catch {
        // 忽略 QUIT 阶段对端提前断连
      }
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        authMode: credentials.authMode,
      };
    } finally {
      session.close();
    }
  }

  async send(
    message: OutreachMailMessage,
    credentials?: OutreachSmtpCredentials,
  ): Promise<{ messageId: string }> {
    this.ensureConfigured(credentials);
    const { effective, isByo } = this.resolveEffectiveCredentials(credentials);
    const dkim = isByo ? null : this.dkimOptions();
    const toAddress = assertSafeEnvelopeAddress(message.to, 'RCPT TO');
    const fromAddress = assertSafeEnvelopeAddress(effective.fromAddress, 'MAIL FROM');
    const messageId = `${randomUUID()}@${fromAddress.split('@')[1] || 'localhost'}`;

    const { session } = await this.openAuthenticatedSession(effective, isByo);
    try {
      session.send(`MAIL FROM:<${fromAddress}>`);
      await session.expect([250], 'MAIL FROM');
      session.send(`RCPT TO:<${toAddress}>`);
      await session.expect([250, 251], 'RCPT TO');
      session.send('DATA');
      await session.expect([354], 'DATA');

      let mime = buildMimeMessage({
        fromAddress,
        fromName: effective.fromName,
        to: toAddress,
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
      try {
        session.send('QUIT');
        await session.expect([221], 'QUIT');
      } catch {
        // 邮件已 250 入队，忽略 QUIT 阶段对端提前断连
      }
      return { messageId };
    } finally {
      session.close();
    }
  }
}

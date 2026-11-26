import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { AuditService } from '../shared/audit.service.js';
import { isEncryptedPii } from '../shared/pii-crypto.js';
import { PiiCryptoService } from '../shared/pii-crypto.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import { OutreachAuthorizationIssuer } from '../campaign/outreach-authorization.issuer.js';
import { CampaignTokenSigner } from '../campaign/campaign-token.signer.js';
import { OutreachAuthorizationConsumer } from './outreach-authorization.consumer.js';
import { OutreachBatchService } from './outreach-batch.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import type { DnsResolver } from './outreach-domain-dns.js';
import { OutreachExperimentsService } from './outreach-experiments.service.js';
import { OutreachHealthService } from './outreach-health.service.js';
import {
  OutreachImapPoller,
  type OutreachImapClient,
  type OutreachImapCredentials,
} from './outreach-imap.poller.js';
import type { OutreachIngestService } from './outreach-ingest.service.js';
import { OutreachMailboxController } from './outreach-mailbox.controller.js';
import { OutreachMailboxService } from './outreach-mailbox.service.js';
import {
  OutreachOAuthService,
  type OutreachOAuthHttpClient,
} from './outreach-oauth.service.js';
import { OUTREACH_PII_PURPOSE } from './outreach-pii.constants.js';
import { OutreachSendControls } from './outreach-send-controls.js';
import { OutreachSendGate } from './outreach-send.gate.js';
import { OutreachSendService } from './outreach-send.service.js';
import {
  SmtpOutreachTransport,
  buildXoauth2Token,
  type OutreachSmtpCredentials,
  type OutreachTransport,
} from './outreach-smtp.transport.js';

const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONTACT_1 = '55555555-5555-4555-8555-555555555555';

const KEY_1 = '11'.repeat(32);
const KEY_2 = '22'.repeat(32);
const TEST_KEYRING = JSON.stringify({ activeKeyId: 'k1', keys: { k1: KEY_1, k2: KEY_2 } });

const tenantA: OutreachTenant = { userId: 'admin-a', workspaceId: WS_A, role: 'admin' };

function errorCode(err: unknown): string {
  return (err as { response?: { error?: { code?: string } } })?.response?.error?.code ?? '';
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    SESSION_SECRET: 's'.repeat(40),
    PII_KEYRING_JSON: TEST_KEYRING,
    OUTREACH_BYO_ALLOW_PRIVATE_HOSTS: false,
    OUTREACH_ENTERPRISE_APPROVAL_REQUIRED: false,
    OUTREACH_SEND_ENABLED: true,
    OUTREACH_SEND_BATCH_LIMIT: 50,
    OUTREACH_APPROVAL_TTL_HOURS: 72,
    OUTREACH_AUTHZ_TTL_MINUTES: 120,
    OUTREACH_AUTHZ_SCHEDULE_DAYS: 7,
    OUTREACH_MAILBOX_DAILY_CAP: 30,
    OUTREACH_MAILBOX_WEEKLY_CAP: 120,
    OUTREACH_DOMAIN_HOURLY_CAP: 5,
    OUTREACH_BATCH_MAX_RECIPIENTS: 50,
    OUTREACH_SEND_WINDOW_START: '00:00',
    OUTREACH_SEND_WINDOW_END: '23:59',
    OUTREACH_SEND_WEEKDAYS: '1,2,3,4,5,6,7',
    OUTREACH_BOUNCE_WINDOW_DAYS: 7,
    OUTREACH_BOUNCE_MIN_SAMPLE: 20,
    OUTREACH_BOUNCE_RATE_HALT: 0.05,
    OUTREACH_COMPLAINT_MIN_SAMPLE: 100,
    OUTREACH_COMPLAINT_RATE_HALT: 0.003,
    OUTREACH_COST_PER_EMAIL_MICROS: 37_000,
    OUTREACH_SMTP_TIMEOUT_MS: 5_000,
    OUTREACH_SMTP_TLS_REJECT_UNAUTHORIZED: false,
    OUTREACH_SMTP_STARTTLS: false,
    OUTREACH_SMTP_SECURE: false,
    OUTREACH_UNSUBSCRIBE_BASE_URL: 'http://127.0.0.1:4020',
    OUTREACH_US_POSTAL_ADDRESS: 'GainOS Inc., 2261 Market St, San Francisco, CA 94114',
    OUTREACH_FR_SOURCE_NOTICE: 'Vos coordonnées proviennent de sources publiques.',
    OUTREACH_OAUTH_GOOGLE_CLIENT_ID: 'google-client-id',
    OUTREACH_OAUTH_GOOGLE_CLIENT_SECRET: 'google-client-secret',
    OUTREACH_OAUTH_GOOGLE_REDIRECT_URI: 'https://app.example.com/api/outreach/oauth/google/callback',
    OUTREACH_OAUTH_M365_CLIENT_ID: 'm365-client-id',
    OUTREACH_OAUTH_M365_CLIENT_SECRET: 'm365-client-secret',
    OUTREACH_OAUTH_M365_REDIRECT_URI: 'https://app.example.com/api/outreach/oauth/m365/callback',
    OUTREACH_OAUTH_M365_TENANT: 'common',
    CAMPAIGN_EXECUTION_SHADOW: false,
    ...overrides,
  } as AppConfig;
}

interface Row {
  [key: string]: unknown;
}

class FakeByoPrisma {
  domains: Row[] = [];
  mailboxes: Row[] = [];
  mailboxCounters: Row[] = [];
  domainCounters: Row[] = [];
  batches: Row[] = [];
  drafts: Row[] = [];
  approvals: Row[] = [];
  events: Row[] = [];
  sends: Row[] = [];
  sendJobs: Row[] = [];
  packages: Row[] = [];
  consents: Row[] = [];
  authorizations: Row[] = [];
  replies: Row[] = [];
  breakers: Row[] = [];
  experiments: Row[] = [];
  assignments: Row[] = [];
  seq = 0;

  private uuid(): string {
    return `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`;
  }

  readonly withWorkspace = async (_ws: string, fn: (tx: this) => Promise<unknown>) => fn(this);

  readonly outreachDomain = {
    upsert: async ({
      where,
      create,
    }: {
      where: { workspaceId_domain: { workspaceId: string; domain: string } };
      create: Row;
    }) => {
      const { workspaceId, domain } = where.workspaceId_domain;
      const found = this.domains.find((d) => d.workspaceId === workspaceId && d.domain === domain);
      if (found) return { ...found };
      const row = {
        id: this.uuid(),
        dkimSelector: null,
        dnsVerifiedAt: null,
        dnsReady: false,
        dnsReport: null,
        createdAt: new Date(),
        ...create,
      };
      this.domains.push(row);
      return { ...row };
    },
    findMany: async ({ where }: { where: Row }) =>
      this.domains.filter((d) => !where.workspaceId || d.workspaceId === where.workspaceId),
    findFirst: async ({ where }: { where: Row }) =>
      this.domains.find(
        (d) =>
          (!where.id || d.id === where.id) &&
          (!where.workspaceId || d.workspaceId === where.workspaceId) &&
          (!where.domain || d.domain === where.domain),
      ) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = this.domains.find((d) => d.id === where.id)!;
      Object.assign(row, data);
      return { ...row };
    },
  };

  readonly outreachMailbox = {
    create: async ({ data }: { data: Row }) => {
      const row = {
        id: this.uuid(),
        authMode: 'password',
        smtpHost: null,
        smtpPort: null,
        smtpSecure: true,
        imapHost: null,
        imapPort: null,
        imapSecure: true,
        imapMailbox: 'INBOX',
        credentialsCiphertext: null,
        credentialsKeyId: null,
        credentialsUpdatedAt: null,
        oauthTokenExpiresAt: null,
        lastVerifiedAt: null,
        lastVerifyStatus: null,
        lastVerifyError: null,
        healthState: 'CLOSED',
        lastSendAt: null,
        createdAt: new Date(),
        ...data,
      };
      this.mailboxes.push(row);
      return { ...row };
    },
    findMany: async ({ where }: { where: Row }) =>
      this.mailboxes.filter((m) => !where.workspaceId || m.workspaceId === where.workspaceId),
    findFirst: async ({ where }: { where: Row }) =>
      this.mailboxes.find(
        (m) =>
          (!where.id || m.id === where.id) &&
          (!where.workspaceId || m.workspaceId === where.workspaceId) &&
          (!where.address || m.address === where.address) &&
          (!where.state || m.state === where.state),
      ) ?? null,
    findUnique: async ({
      where,
    }: {
      where: { workspaceId_address: { workspaceId: string; address: string } };
    }) => {
      const { workspaceId, address } = where.workspaceId_address;
      return this.mailboxes.find((m) => m.workspaceId === workspaceId && m.address === address) ?? null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = this.mailboxes.find((m) => m.id === where.id)!;
      Object.assign(row, data);
      return { ...row };
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const idx = this.mailboxes.findIndex((m) => m.id === where.id);
      if (idx >= 0) this.mailboxes.splice(idx, 1);
      return { id: where.id };
    },
  };

  readonly outreachMailboxCounter = {
    findFirst: async () => null,
    aggregate: async () => ({ _sum: { sent: 0 } }),
    upsert: async ({ create }: { create: Row }) => {
      this.mailboxCounters.push(create);
      return create;
    },
  };

  readonly outreachDomainCounter = {
    upsert: async ({ create }: { create: Row }) => {
      this.domainCounters.push(create);
      return create;
    },
  };

  readonly outreachBatch = {
    create: async ({ data }: { data: Row }) => {
      const row = {
        id: this.uuid(),
        status: 'DRAFT',
        contentHash: null,
        authorizationId: null,
        mailboxId: null,
        submittedAt: null,
        decidedAt: null,
        queuedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      this.batches.push(row);
      return { ...row };
    },
    findFirst: async ({ where, include }: { where: Row; include?: Row }) => {
      const row = this.batches.find(
        (b) =>
          (!where.id || b.id === where.id) &&
          (!where.workspaceId || b.workspaceId === where.workspaceId),
      );
      if (!row) return null;
      const view: Row = { ...row };
      if (include?.drafts) {
        view.drafts = this.drafts.filter((d) => d.batchId === row.id).map((d) => ({ ...d }));
      }
      if (include?.approvals) {
        const st = (include.approvals as { where?: { state?: string } }).where?.state;
        view.approvals = this.approvals
          .filter((a) => a.batchId === row.id && (!st || a.state === st))
          .map((a) => ({ ...a }));
      }
      if (include?.events) {
        view.events = this.events.filter((e) => e.batchId === row.id).map((e) => ({ ...e }));
      }
      if (include?.sends) {
        view.sends = this.sends.filter((s) => s.batchId === row.id).map((s) => ({ ...s }));
      }
      return view;
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = this.batches.find((b) => b.id === where.id)!;
      Object.assign(row, data);
      return { ...row };
    },
  };

  readonly outreachDraft = {
    count: async ({ where }: { where: Row }) =>
      this.drafts.filter((d) => d.batchId === where.batchId).length,
    create: async ({ data }: { data: Row }) => {
      const row = {
        id: this.uuid(),
        status: 'DRAFT',
        contentHash: null,
        approvedBy: null,
        approvedAt: null,
        rejectionReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      this.drafts.push(row);
      return { ...row };
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = this.drafts.find((d) => d.id === where.id)!;
      Object.assign(row, data);
      return { ...row };
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      let count = 0;
      for (const d of this.drafts) {
        if ((!where.batchId || d.batchId === where.batchId) && (!where.status || d.status === where.status)) {
          Object.assign(d, data);
          count += 1;
        }
      }
      return { count };
    },
  };

  readonly outreachBatchApproval = {
    create: async ({ data }: { data: Row }) => {
      const row = { id: this.uuid(), createdAt: new Date(), ...data };
      this.approvals.push(row);
      return { ...row };
    },
  };

  readonly outreachBatchEvent = {
    create: async ({ data }: { data: Row }) => {
      const row = { id: this.uuid(), createdAt: new Date(), ...data };
      this.events.push(row);
      return { ...row };
    },
  };

  readonly outreachSendJob = {
    createMany: async ({ data }: { data: Row[] }) => {
      this.sendJobs.push(...data);
      return { count: data.length };
    },
  };

  readonly outreachSend = {
    create: async ({ data }: { data: Row }) => {
      const row = { id: this.uuid(), createdAt: new Date(), ...data };
      this.sends.push(row);
      return { ...row };
    },
    count: async ({ where }: { where: Row }) =>
      this.sends.filter((s) => s.workspaceId === where.workspaceId && s.status === where.status).length,
    findMany: async ({ where }: { where: Row }) =>
      this.sends.filter(
        (s) =>
          s.workspaceId === where.workspaceId &&
          (!where.mailboxAddress || s.mailboxAddress === where.mailboxAddress) &&
          (!where.status || s.status === where.status),
      ),
    findFirst: async () => null,
  };

  readonly outreachReply = {
    count: async () => 0,
  };

  readonly outreachConsent = {
    findMany: async ({ where }: { where: Row }) =>
      this.consents.filter(
        (c) =>
          c.workspaceId === where.workspaceId &&
          (where.contactRef as { in: string[] }).in.includes(c.contactRef as string),
      ),
  };

  readonly outreachBreaker = {
    findMany: async () => this.breakers,
    findUnique: async () => null,
  };

  readonly outreachSeedTest = {
    findFirst: async () => null,
  };

  readonly outreachAuditPackage = {
    findFirst: async () => null,
    create: async ({ data }: { data: Row }) => {
      const row = { id: this.uuid(), createdAt: new Date(), ...data };
      this.packages.push(row);
      return row;
    },
  };

  readonly campaignExecutionAuthorization = {
    create: async ({ data }: { data: Row }) => {
      const row = { createdAt: new Date(), ...data };
      this.authorizations.push(row);
      return { ...row };
    },
    findFirst: async ({ where }: { where: Row }) =>
      this.authorizations.find(
        (a) =>
          (!where.id || a.id === where.id) &&
          (!where.workspaceId || a.workspaceId === where.workspaceId),
      ) ?? null,
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.authorizations.find((a) => a.id === where.id) ?? null,
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const row = this.authorizations.find(
        (a) => a.id === where.id && (a.uses as number) < (where.uses as { lt: number }).lt,
      );
      if (!row) return { count: 0 };
      row.uses = (row.uses as number) + (data.uses as { increment: number }).increment;
      return { count: 1 };
    },
  };

  readonly outreachExperiment = { findMany: async () => [] };
  readonly outreachExperimentAssignment = { findMany: async () => [] };
}

/** 轻量本地 TCP 模拟 SMTP 服务器：验证 AUTH PLAIN / AUTH XOAUTH2 握手与零发信 testConnection。 */
async function startMockSmtpServer(options: {
  capabilities: string[];
  acceptAuth: (line: string) => boolean;
}): Promise<{ port: number; commands: string[]; close: () => Promise<void> }> {
  const commands: string[] = [];
  const server: Server = createServer((socket: Socket) => {
    socket.write('220 mock-smtp.local ESMTP ready\r\n');
    let buf = '';
    let inData = false;
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      while (true) {
        if (inData) {
          const endIdx = buf.indexOf('\r\n.\r\n');
          if (endIdx === -1) break;
          buf = buf.slice(endIdx + 5);
          inData = false;
          socket.write('250 2.0.0 Queued\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl === -1) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        commands.push(line);
        if (line.startsWith('EHLO')) {
          const lines = ['250-mock-smtp.local', ...options.capabilities.slice(0, -1).map((c) => `250-${c}`), `250 ${options.capabilities[options.capabilities.length - 1]}`];
          socket.write(`${lines.join('\r\n')}\r\n`);
        } else if (line.startsWith('AUTH ')) {
          if (options.acceptAuth(line)) {
            socket.write('235 2.7.0 Authentication successful\r\n');
          } else {
            socket.write('535 5.7.8 Authentication credentials invalid\r\n');
          }
        } else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) {
          socket.write('250 2.1.0 OK\r\n');
        } else if (line === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (line === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 OK\r\n');
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    port: address.port,
    commands,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('M9-PR3 BYO 发信箱加密托管、OAuth2、隔离 IMAP 与 SMB 一键确认', () => {
  const serversToClose: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (serversToClose.length > 0) {
      await serversToClose.pop()!();
    }
  });

  it('BYO 加密凭据托管：落库 enc:v2 密文、绝不回显密码/密文、阻断 SSRF 内网主机与非法端口', async () => {
    const prisma = new FakeByoPrisma();
    const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
    const config = makeConfig();
    const crypto = new PiiCryptoService(config);
    const service = new OutreachMailboxService(
      prisma as unknown as PrismaService,
      audit,
      config,
      crypto,
    );

    const created = await service.createMailbox(tenantA, {
      address: 'sales@exporter.example',
      displayName: 'Exporter Sales',
    });
    expect(created.hasCredentials).toBe(false);
    expect('credentialsCiphertext' in created).toBe(false);

    // SSRF 防护：拦截内网 / 回环 / 云元数据主机与非常规端口
    await expect(
      service.configureCredentials(tenantA, created.id, {
        authMode: 'password',
        smtpHost: '169.254.169.254',
        smtpPort: 587,
        password: 'app-password',
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'VALIDATION_ERROR');

    await expect(
      service.configureCredentials(tenantA, created.id, {
        authMode: 'password',
        smtpHost: 'smtp.gmail.com',
        smtpPort: 22,
        password: 'app-password',
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'VALIDATION_ERROR');

    // 正常保存加密凭据
    const updated = await service.configureCredentials(tenantA, created.id, {
      authMode: 'password',
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      smtpSecure: true,
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      imapSecure: true,
      username: 'sales@exporter.example',
      password: 'super-secret-app-password',
    });

    expect(updated.hasCredentials).toBe(true);
    expect(updated.smtpHost).toBe('smtp.gmail.com');
    expect(updated.imapHost).toBe('imap.gmail.com');
    expect(JSON.stringify(updated)).not.toContain('super-secret-app-password');
    expect(JSON.stringify(updated)).not.toContain('enc:v2:');

    const rawRow = prisma.mailboxes.find((m) => m.id === created.id)!;
    expect(isEncryptedPii(rawRow.credentialsCiphertext as string)).toBe(true);
    expect(String(rawRow.credentialsCiphertext)).not.toContain('super-secret-app-password');

    // 删除信箱
    const removed = await service.deleteMailbox(tenantA, created.id);
    expect(removed).toEqual({ deleted: true, id: created.id });
    expect(prisma.mailboxes).toHaveLength(0);
  });

  it('SmtpOutreachTransport BYO 实时握手测试（AUTH PLAIN & AUTH XOAUTH2，不发送测试邮件）', async () => {
    const expectedXoauth = buildXoauth2Token('sales@exporter.example', 'ya29.test-access-token');
    const mockSmtp = await startMockSmtpServer({
      capabilities: ['SIZE 35882577', 'AUTH PLAIN XOAUTH2'],
      acceptAuth: (line) =>
        line === `AUTH PLAIN ${Buffer.from('\0sales@exporter.example\0app-pass-123').toString('base64')}` ||
        line === `AUTH XOAUTH2 ${expectedXoauth}`,
    });
    serversToClose.push(mockSmtp.close);

    const transport = new SmtpOutreachTransport(
      makeConfig({ OUTREACH_BYO_ALLOW_PRIVATE_HOSTS: true }),
    );

    const plainCreds: OutreachSmtpCredentials = {
      host: '127.0.0.1',
      port: mockSmtp.port,
      secure: false,
      starttls: false,
      fromAddress: 'sales@exporter.example',
      fromName: 'Exporter Sales',
      authMode: 'password',
      user: 'sales@exporter.example',
      password: 'app-pass-123',
    };
    const plainRes = await transport.testConnection(plainCreds);
    expect(plainRes.ok).toBe(true);
    expect(plainRes.authMode).toBe('password');

    const oauthRes = await transport.testConnection({
      ...plainCreds,
      authMode: 'oauth_google',
      password: undefined,
      accessToken: 'ya29.test-access-token',
    });
    expect(oauthRes.ok).toBe(true);
    expect(oauthRes.authMode).toBe('oauth_google');

    // testConnection 绝不发出 MAIL FROM / RCPT TO / DATA
    expect(mockSmtp.commands.some((c) => c.startsWith('MAIL FROM:'))).toBe(false);
    expect(mockSmtp.commands.some((c) => c === 'DATA')).toBe(false);

    // 密码错误返回协议错误
    await expect(
      transport.testConnection({ ...plainCreds, password: 'wrong-password' }),
    ).rejects.toThrow(/535/);
  });

  it('发信域 DNS 核验（SPF / DKIM / DMARC / MX）复用 #214 体检引擎并落库快照', async () => {
    const prisma = new FakeByoPrisma();
    const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
    const config = makeConfig();
    const dns: DnsResolver = {
      resolveTxt: vi.fn(async (host: string) => {
        if (host === 'exporter.example') return [['v=spf1 include:_spf.google.com ~all']];
        if (host === 'google._domainkey.exporter.example') return [['v=DKIM1; k=rsa; p=MIIBIjANBgkqhki']];
        if (host === '_dmarc.exporter.example') return [['v=DMARC1; p=quarantine; rua=mailto:dmarc@exporter.example']];
        return [];
      }),
      resolveMx: vi.fn(async () => [{ exchange: 'aspmx.l.google.com', priority: 1 }]),
    };

    const service = new OutreachMailboxService(
      prisma as unknown as PrismaService,
      audit,
      config,
      new PiiCryptoService(config),
      undefined,
      undefined,
      dns,
    );
    await service.createMailbox(tenantA, {
      address: 'sales@exporter.example',
      displayName: 'Sales',
    });
    const domains = await service.listDomains(tenantA);
    expect(domains).toHaveLength(1);

    const verified = await service.verifyDomainDns(tenantA, domains[0]!.id as string, 'google');
    expect(verified.report.ready).toBe(true);
    expect(verified.report.ok.spf).toBe(true);
    expect(verified.report.ok.dkim).toBe(true);
    expect(verified.report.ok.dmarc).toBe(true);
    expect(verified.report.ok.mx).toBe(true);
    expect(verified.domain.dnsReady).toBe(true);
    expect(verified.domain.dnsVerifiedAt).toBeInstanceOf(Date);
    expect(verified.template).toContain('v=spf1');
    expect(verified.template).toContain('v=DMARC1');
  });

  it('Google / M365 OAuth2 start + callback（CSRF 防篡改/防重放/防邮箱错配）与自动静默续期', async () => {
    const prisma = new FakeByoPrisma();
    const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
    const config = makeConfig();
    const crypto = new PiiCryptoService(config);
    const httpClient: OutreachOAuthHttpClient = {
      exchangeCode: vi.fn(async () => ({
        accessToken: 'google-access-initial',
        refreshToken: 'google-refresh-1',
        expiresIn: 3600,
        email: 'sales@exporter.example',
      })),
      refreshToken: vi.fn(async () => ({
        accessToken: 'google-access-refreshed',
        expiresIn: 3600,
      })),
    };
    const mailboxSvc = new OutreachMailboxService(
      prisma as unknown as PrismaService,
      audit,
      config,
      crypto,
    );
    const created = await mailboxSvc.createMailbox(tenantA, {
      address: 'sales@exporter.example',
      displayName: 'Sales',
    });

    const oauth = new OutreachOAuthService(
      prisma as unknown as PrismaService,
      audit,
      crypto,
      config,
      httpClient,
    );

    const started = await oauth.startAuthorization(tenantA, created.id, 'google');
    const url = new URL(started.authorizeUrl);
    expect(url.origin).toBe('https://accounts.google.com');
    const state = url.searchParams.get('state')!;
    expect(state).toBeTruthy();

    // 篡改 state → 拒绝（防 CSRF）
    await expect(
      oauth.handleCallback(tenantA, 'google', { code: 'auth-code-1', state: `${state}tampered` }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'OUTREACH_OAUTH_STATE_INVALID');

    // 跨 provider 提交 state → 拒绝（AAD 绑定 provider）
    await expect(
      oauth.handleCallback(tenantA, 'm365', { code: 'auth-code-1', state }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'OUTREACH_OAUTH_STATE_INVALID');

    // 跨用户 / 跨工作空间回调（Login-CSRF）→ 403 拒绝且不消费合法管理员的 nonce
    await expect(
      oauth.handleCallback(
        { userId: 'other-admin', workspaceId: WS_A, role: 'admin' },
        'google',
        { code: 'auth-code-1', state },
      ),
    ).rejects.toSatisfy((e) => errorCode(e) === 'OUTREACH_OAUTH_SESSION_MISMATCH');
    await expect(
      oauth.handleCallback(
        { userId: 'admin-a', workspaceId: WS_B, role: 'admin' },
        'google',
        { code: 'auth-code-1', state },
      ),
    ).rejects.toSatisfy((e) => errorCode(e) === 'OUTREACH_OAUTH_SESSION_MISMATCH');

    // 正常回调绑定成功且不回显令牌
    const connected = await oauth.handleCallback(tenantA, 'google', { code: 'auth-code-1', state });
    expect(connected.mailbox.authMode).toBe('oauth_google');
    expect(connected.mailbox.smtpHost).toBe('smtp.gmail.com');
    expect(connected.mailbox.imapHost).toBe('imap.gmail.com');
    expect(connected.mailbox.hasCredentials).toBe(true);
    expect(connected.mailbox.oauthConnected).toBe(true);
    expect(JSON.stringify(connected)).not.toContain('google-access-initial');
    expect(JSON.stringify(connected)).not.toContain('google-refresh-1');

    // 重放同一 state → 拒绝
    await expect(
      oauth.handleCallback(tenantA, 'google', { code: 'auth-code-1', state }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'OUTREACH_OAUTH_STATE_REPLAYED');

    // 缺失 email claim 或 emailVerified=false → fail-closed 拒绝（不得静默放行）
    const startedMissingEmail = await oauth.startAuthorization(tenantA, created.id, 'google');
    const stateMissingEmail = new URL(startedMissingEmail.authorizeUrl).searchParams.get('state')!;
    (httpClient.exchangeCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      accessToken: 'no-email-token',
      refreshToken: 'no-email-refresh',
      expiresIn: 3600,
    });
    await expect(
      oauth.handleCallback(tenantA, 'google', { code: 'code-no-email', state: stateMissingEmail }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'OUTREACH_OAUTH_EMAIL_UNVERIFIED');

    const startedUnverified = await oauth.startAuthorization(tenantA, created.id, 'google');
    const stateUnverified = new URL(startedUnverified.authorizeUrl).searchParams.get('state')!;
    (httpClient.exchangeCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      accessToken: 'unverified-token',
      expiresIn: 3600,
      email: 'sales@exporter.example',
      emailVerified: false,
    });
    await expect(
      oauth.handleCallback(tenantA, 'google', { code: 'code-unverified', state: stateUnverified }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'OUTREACH_OAUTH_EMAIL_UNVERIFIED');

    // 邮箱不匹配 → 拒绝绑定
    const started2 = await oauth.startAuthorization(tenantA, created.id, 'google');
    const state2 = new URL(started2.authorizeUrl).searchParams.get('state')!;
    (httpClient.exchangeCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      accessToken: 'wrong-user-token',
      refreshToken: 'wrong-refresh',
      expiresIn: 3600,
      email: 'attacker@other.example',
      emailVerified: true,
    });
    await expect(
      oauth.handleCallback(tenantA, 'google', { code: 'code-2', state: state2 }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'OUTREACH_OAUTH_EMAIL_MISMATCH');

    // 令牌临近过期时自动静默续期并重写密文
    const refreshed = await oauth.refreshOAuthCredentialsIfNeeded(
      WS_A,
      created.id,
      {
        authMode: 'oauth_google',
        username: 'sales@exporter.example',
        accessToken: 'expired-token',
        refreshToken: 'google-refresh-1',
        expiresAt: new Date(Date.now() - 10_000).toISOString(),
      },
    );
    expect(refreshed.accessToken).toBe('google-access-refreshed');
    expect(httpClient.refreshToken).toHaveBeenCalledTimes(1);
  });

  it('多租户隔离 BYO IMAP 轮询：每租户使用独立解密凭据且 UNMATCHED 立即标 \\Seen（根治污染与死循环）', async () => {
    const config = makeConfig();
    const crypto = new PiiCryptoService(config);
    const ctA = crypto.encryptSecret(
      WS_A,
      JSON.stringify({ authMode: 'password', username: 'a@tenant-a.example', password: 'pw-a' }),
      OUTREACH_PII_PURPOSE.MAILBOX_CREDENTIALS,
    ).ciphertext;
    const ctB = crypto.encryptSecret(
      WS_B,
      JSON.stringify({ authMode: 'password', username: 'b@tenant-b.example', password: 'pw-b' }),
      OUTREACH_PII_PURPOSE.MAILBOX_CREDENTIALS,
    ).ciphertext;

    const fakePrisma = {
      $queryRaw: vi.fn(async () => [
        {
          id: 'mb-a',
          workspace_id: WS_A,
          address: 'a@tenant-a.example',
          auth_mode: 'password',
          imap_host: 'imap.tenant-a.example',
          imap_port: 993,
          imap_secure: true,
          imap_mailbox: 'INBOX',
          credentials_ciphertext: ctA,
        },
        {
          id: 'mb-b',
          workspace_id: WS_B,
          address: 'b@tenant-b.example',
          auth_mode: 'password',
          imap_host: 'imap.tenant-b.example',
          imap_port: 993,
          imap_secure: true,
          imap_mailbox: 'INBOX',
          credentials_ciphertext: ctB,
        },
      ]),
    } as unknown as PrismaService;

    const seenByAccount: Array<{ account: string; uid: number; host?: string }> = [];
    const fetchedCreds: OutreachImapCredentials[] = [];
    const client: OutreachImapClient = {
      fetchUnseen: vi.fn(async (account: string, creds?: OutreachImapCredentials) => {
        if (creds) fetchedCreds.push(creds);
        return account === 'a@tenant-a.example'
          ? [{ uid: 101, raw: 'Subject: Newsletter' }]
          : [{ uid: 202, raw: 'Subject: Re: Quote' }];
      }),
      markSeen: vi.fn(async (account: string, uid: number, creds?: OutreachImapCredentials) => {
        seenByAccount.push({ account, uid, host: creds?.host });
      }),
    };
    const ingest = {
      ingest: vi.fn(async (t: OutreachTenant) =>
        t.workspaceId === WS_A
          ? { outcome: 'UNMATCHED' }
          : { outcome: 'RECORDED' },
      ),
    } as unknown as OutreachIngestService;

    const poller = new OutreachImapPoller(fakePrisma, ingest, client, config, crypto);
    const summary = await poller.pollOnce();

    expect(summary).toEqual({ processed: 1, duplicates: 0, unmatched: 1, errors: 0 });
    expect(fetchedCreds.map((c) => `${c.host}:${c.password}`)).toEqual([
      'imap.tenant-a.example:pw-a',
      'imap.tenant-b.example:pw-b',
    ]);
    // 关键：隔离 BYO 信箱即使 UNMATCHED 也立即标 \Seen，不再反复重扫或污染其他租户
    expect(seenByAccount).toEqual([
      { account: 'a@tenant-a.example', uid: 101, host: 'imap.tenant-a.example' },
      { account: 'b@tenant-b.example', uid: 202, host: 'imap.tenant-b.example' },
    ]);
  });

  it('BYO 仅配置 SMTP（未配 IMAP）的信箱绝不回落平台共享 env IMAP，防跨租户串信', async () => {
    const config = makeConfig({ OUTREACH_IMAP_HOST: 'imap.shared-platform.example' });
    const crypto = new PiiCryptoService(config);
    const ctSmtpOnly = crypto.encryptSecret(
      WS_A,
      JSON.stringify({ authMode: 'password', username: 'smtp-only@tenant-a.example', password: 'pw' }),
      OUTREACH_PII_PURPOSE.MAILBOX_CREDENTIALS,
    ).ciphertext;

    const fakePrisma = {
      $queryRaw: vi.fn(async () => [
        {
          id: 'mb-smtp-only',
          workspace_id: WS_A,
          address: 'smtp-only@tenant-a.example',
          auth_mode: 'password',
          imap_host: null,
          imap_port: null,
          imap_secure: true,
          imap_mailbox: 'INBOX',
          credentials_ciphertext: ctSmtpOnly,
        },
      ]),
    } as unknown as PrismaService;

    const client: OutreachImapClient = {
      fetchUnseen: vi.fn(async () => [{ uid: 1, raw: 'should-never-be-fetched' }]),
      markSeen: vi.fn(async () => undefined),
    };
    const ingest = { ingest: vi.fn(async () => ({ outcome: 'RECORDED' })) } as unknown as OutreachIngestService;

    const poller = new OutreachImapPoller(fakePrisma, ingest, client, config, crypto);
    const summary = await poller.pollOnce();
    expect(summary).toEqual({ processed: 0, duplicates: 0, unmatched: 0, errors: 0 });
    expect(client.fetchUnseen).not.toHaveBeenCalled();
    expect(ingest.ingest).not.toHaveBeenCalled();
  });

  it('OutreachMailboxController 拒绝 dailyCap/weeklyCap/smtpPort 传入布尔值，quickConfirm 拦截 PAUSED 信箱', async () => {
    const prisma = new FakeByoPrisma();
    const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
    const config = makeConfig();
    const crypto = new PiiCryptoService(config);
    const mailboxSvc = new OutreachMailboxService(
      prisma as unknown as PrismaService,
      audit,
      config,
      crypto,
    );
    const controller = new OutreachMailboxController(mailboxSvc);
    const fakeReq = { tenant: tenantA } as never;

    await expect(
      controller.create(fakeReq, {
        address: 'strict@exporter.example',
        displayName: 'Strict',
        dailyCap: true,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'VALIDATION_ERROR');

    await expect(
      controller.create(fakeReq, {
        address: 'strict@exporter.example',
        displayName: 'Strict',
        weeklyCap: false,
      }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'VALIDATION_ERROR');

    // PAUSED 信箱在 preflight 与 quickConfirmBatch 均被拒绝
    const pausedMb = await mailboxSvc.createMailbox(tenantA, {
      address: 'paused@exporter.example',
      displayName: 'Paused',
      state: 'PAUSED',
    });
    await mailboxSvc.configureCredentials(tenantA, pausedMb.id, {
      authMode: 'password',
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      smtpSecure: true,
      password: 'secret',
    });

    const signer = new CampaignTokenSigner(config);
    const issuer = new OutreachAuthorizationIssuer(
      prisma as unknown as PrismaService,
      signer,
      audit,
      config,
      crypto,
    );
    const batches = new OutreachBatchService(
      prisma as unknown as PrismaService,
      audit,
      config,
      issuer,
      crypto,
    );
    const batch = await batches.createBatch(tenantA, { name: 'Paused Mailbox Check' });
    await batches.addDraft(tenantA, batch.id as string, {
      contactRef: CONTACT_1,
      recipientEmail: 'buyer@us-importer.example',
      countryCode: 'US',
      companyName: 'US Corp',
      subject: 'Hello',
      body: 'Body',
    });
    await expect(
      batches.quickConfirmBatch(tenantA, batch.id as string, { mailboxId: pausedMb.id }),
    ).rejects.toSatisfy((e) => errorCode(e) === 'OUTREACH_MAILBOX_PAUSED');

    const sendSvc = new OutreachSendService(
      prisma as unknown as PrismaService,
      audit,
      new OutreachSendGate(config),
      { ensureConfigured: vi.fn(), send: vi.fn() },
      { check: vi.fn(async () => new Map()) },
      { check: vi.fn(async () => new Map()) } as never,
      { enqueue: vi.fn(async () => undefined) } as never,
      { issue: vi.fn() } as never,
      config,
      new OutreachSendControls(prisma as unknown as PrismaService, config, crypto),
      new OutreachAuthorizationConsumer(prisma as unknown as PrismaService, config),
      mailboxSvc,
      new OutreachHealthService(prisma as unknown as PrismaService, audit, config),
      new OutreachExperimentsService(prisma as unknown as PrismaService, audit),
      crypto,
    );
    const pf = await sendSvc.preflightBatch(tenantA, batch.id as string, { mailboxId: pausedMb.id });
    expect(pf.mailbox.ready).toBe(false);
    expect(pf.mailbox.error).toContain('PAUSED');
  });

  it('SMB 合规预检 → 一键确认 → BYO 凭据发送 + PII 落库 enc:v2，且保留全部法域与企业审批底线', async () => {
    const prisma = new FakeByoPrisma();
    const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
    const config = makeConfig();
    const crypto = new PiiCryptoService(config);
    const signer = new CampaignTokenSigner(config);
    const issuer = new OutreachAuthorizationIssuer(
      prisma as unknown as PrismaService,
      signer,
      audit,
      config,
      crypto,
    );
    const batches = new OutreachBatchService(
      prisma as unknown as PrismaService,
      audit,
      config,
      issuer,
      crypto,
    );
    const mailboxSvc = new OutreachMailboxService(
      prisma as unknown as PrismaService,
      audit,
      config,
      crypto,
    );

    const mb = await mailboxSvc.createMailbox(tenantA, {
      address: 'sales@exporter.example',
      displayName: 'Exporter Sales',
    });
    await mailboxSvc.configureCredentials(tenantA, mb.id, {
      authMode: 'password',
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      smtpSecure: true,
      password: 'byo-send-secret',
    });

    const batch = await batches.createBatch(tenantA, { name: 'US 首触快捷批', mailboxId: mb.id });
    const draft = await batches.addDraft(tenantA, batch.id as string, {
      contactRef: CONTACT_1,
      recipientEmail: 'buyer@us-importer.example',
      countryCode: 'US',
      companyName: 'US Importer LLC',
      subject: 'Pump catalog',
      body: 'Hello buyer,',
    });

    // 草稿落库必须为 enc:v2 密文，但接口返回明文
    expect(draft.recipientEmail).toBe('buyer@us-importer.example');
    expect(isEncryptedPii(prisma.drafts[0]!.recipientEmail as string)).toBe(true);
    expect(String(prisma.drafts[0]!.recipientEmail)).not.toContain('buyer@us-importer.example');

    const sentCredentials: Array<OutreachSmtpCredentials | undefined> = [];
    const transport: OutreachTransport = {
      ensureConfigured: vi.fn(),
      send: vi.fn(async (_msg, creds) => {
        sentCredentials.push(creds);
        return { messageId: 'msg-byo-1@exporter.example' };
      }),
    };
    const controls = new OutreachSendControls(prisma as unknown as PrismaService, config, crypto);
    const sendSvc = new OutreachSendService(
      prisma as unknown as PrismaService,
      audit,
      new OutreachSendGate(config),
      transport,
      { check: vi.fn(async () => new Map()) },
      { check: vi.fn(async () => new Map()) } as never,
      { enqueue: vi.fn(async () => undefined) } as never,
      { issue: vi.fn(async () => ({ token: 'unsub-tok-1', expiresAt: new Date(), tokenId: 't1' })) } as never,
      config,
      controls,
      new OutreachAuthorizationConsumer(prisma as unknown as PrismaService, config),
      mailboxSvc,
      new OutreachHealthService(prisma as unknown as PrismaService, audit, config),
      new OutreachExperimentsService(prisma as unknown as PrismaService, audit),
      crypto,
    );

    // 1. 合规自动预检（US 有物理地址页脚 → 放行）
    const preflight = await sendSvc.preflightBatch(tenantA, batch.id as string);
    expect(preflight.readyCount).toBe(1);
    expect(preflight.quickConfirmAllowed).toBe(true);
    expect(preflight.mailbox).toMatchObject({
      ready: true,
      source: 'byo',
      address: 'sales@exporter.example',
    });

    // 2. 一键确认（跳过两段式审批但签发 ExecutionAuthorization v2 与留痕）
    const confirmed = await batches.quickConfirmBatch(tenantA, batch.id as string, {
      mailboxId: mb.id,
    });
    expect(confirmed.status).toBe('QUEUED');
    expect(confirmed.authorizationId).toBeTruthy();

    // 3. 发送使用租户 BYO 解密凭据，并把 outreach_send.recipient_email 加密落库
    const summary = await sendSvc.sendBatch(tenantA, batch.id as string);
    expect(summary).toMatchObject({ status: 'SENT', sent: 1, failed: 0 });
    expect(sentCredentials[0]).toMatchObject({
      host: 'smtp.gmail.com',
      port: 465,
      fromAddress: 'sales@exporter.example',
      password: 'byo-send-secret',
    });
    expect(isEncryptedPii(prisma.sends[0]!.recipientEmail as string)).toBe(true);
    expect(prisma.sends[0]!.mailboxAddress).toBe('sales@exporter.example');

    // 4. 开启企业多级审批开关时，一键确认必须被 409 拦截
    const enterpriseConfig = makeConfig({ OUTREACH_ENTERPRISE_APPROVAL_REQUIRED: true });
    const enterpriseBatches = new OutreachBatchService(
      prisma as unknown as PrismaService,
      audit,
      enterpriseConfig,
      issuer,
      crypto,
    );
    const batch2 = await enterpriseBatches.createBatch(tenantA, { name: '企业审批批' });
    await enterpriseBatches.addDraft(tenantA, batch2.id as string, {
      contactRef: CONTACT_1,
      recipientEmail: 'buyer2@us-importer.example',
      countryCode: 'DE',
      companyName: 'DE GmbH',
      subject: 'Hi',
      body: 'Body',
    });
    await expect(
      enterpriseBatches.quickConfirmBatch(tenantA, batch2.id as string),
    ).rejects.toSatisfy((e) => errorCode(e) === 'OUTREACH_ENTERPRISE_APPROVAL_REQUIRED');

    // 5. DE 收件人无 OPT_IN 时 preflight 仍严格阻断（法律底线绝不放宽）
    const dePreflight = await sendSvc.preflightBatch(tenantA, batch2.id as string);
    expect(dePreflight.readyCount).toBe(0);
    expect(dePreflight.skippedCount).toBe(1);
    expect(dePreflight.drafts[0]?.skipCode).toBe('JURISDICTION_CONSENT_REQUIRED');
  });
});

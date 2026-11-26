import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { evaluateDomainDnsAdvice } from '@gain-saas/shared';
import { resolveMx, resolveTxt } from 'node:dns/promises';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { AuditService } from '../shared/audit.service.js';
import { PiiCryptoService } from '../shared/pii-crypto.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import {
  dnsRecordTemplate,
  inspectSenderDomain,
  type DnsResolver,
} from './outreach-domain-dns.js';
import { assertSafeMailHost } from './outreach-host-guard.js';
import {
  OUTREACH_IMAP_CLIENT,
  type OutreachImapClient,
  type OutreachImapCredentials,
} from './outreach-imap.poller.js';
import { OutreachOAuthService } from './outreach-oauth.service.js';
import {
  MAILBOX_AUTH_MODES,
  OUTREACH_PII_PURPOSE,
  sanitizeMailboxRow,
  type MailboxAuthMode,
  type SanitizedMailboxView,
  type StoredMailboxCredentials,
} from './outreach-pii.constants.js';
import {
  OUTREACH_TRANSPORT,
  type OutreachSmtpCredentials,
  type OutreachTransport,
} from './outreach-smtp.transport.js';

export const OUTREACH_MAILBOX_DNS_RESOLVER = Symbol('OUTREACH_MAILBOX_DNS_RESOLVER');

const DEFAULT_DNS_RESOLVER: DnsResolver = {
  resolveTxt: (name) => resolveTxt(name),
  resolveMx: (name) => resolveMx(name),
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DKIM_SELECTOR_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

export const WARMUP_STAGES = ['W1', 'W2', 'W3', 'MATURE'] as const;
export type WarmupStage = (typeof WARMUP_STAGES)[number];
const MAILBOX_STATES = ['ACTIVE', 'PAUSED', 'RETIRED'] as const;
type MailboxState = (typeof MAILBOX_STATES)[number];

/** warmup 阶梯的默认日/周上限（ch05 §5.3.3.3；扩量靠加信箱，不提高单箱上限）。 */
export const WARMUP_STAGE_CAPS: Record<WarmupStage, { daily: number; weekly: number }> = {
  W1: { daily: 10, weekly: 50 },
  W2: { daily: 20, weekly: 100 },
  W3: { daily: 30, weekly: 150 },
  MATURE: { daily: 40, weekly: 200 },
};

export interface OutreachMailboxInput {
  address?: unknown;
  displayName?: unknown;
  provider?: unknown;
  warmupStage?: unknown;
  dailyCap?: unknown;
  weeklyCap?: unknown;
  timezone?: unknown;
  state?: unknown;
}

export interface ConfigureMailboxCredentialsInput {
  authMode?: MailboxAuthMode;
  smtpHost: string;
  smtpPort: number;
  smtpSecure?: boolean;
  imapHost?: string | null;
  imapPort?: number | null;
  imapSecure?: boolean;
  imapMailbox?: string;
  username?: string;
  password?: string;
  imapUsername?: string;
  imapPassword?: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthTokenExpiresAt?: string;
}

export interface OutboxUsage {
  dailySent: number;
  weeklySent: number;
}

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}
function notFound(): never {
  throw new NotFoundException({
    error: { code: 'OUTREACH_MAILBOX_NOT_FOUND', message: '发件信箱不存在' },
  });
}
function domainNotFound(): never {
  throw new NotFoundException({
    error: { code: 'OUTREACH_DOMAIN_NOT_FOUND', message: '发信域名不存在' },
  });
}
function conflict(code: string, message: string): never {
  throw new ConflictException({ error: { code, message } });
}

function utcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function domainOf(address: string): string {
  return address.split('@')[1]?.toLowerCase() ?? '';
}

function recipientDomainOf(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? '';
}

/**
 * 发件资产与 BYO 邮箱加密凭据托管服务（P4-02 + M9-PR2）：
 * - 域名/信箱/日周配额计数/warmup 阶梯；
 * - 信封加密（enc:v2 + workspaceId AAD）托管租户自定义 SMTP/IMAP 密码或 OAuth2 令牌，绝不明文回显；
 * - 实时 SMTP/IMAP 连通性自检与域名 SPF/DKIM/DMARC/MX 核验落库。
 */
@Injectable()
export class OutreachMailboxService {
  private readonly dns: DnsResolver;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() private readonly crypto?: PiiCryptoService,
    @Optional() @Inject(OUTREACH_TRANSPORT) private readonly transport?: OutreachTransport,
    @Optional() @Inject(OUTREACH_IMAP_CLIENT) private readonly imapClient?: OutreachImapClient,
    @Optional() @Inject(OUTREACH_MAILBOX_DNS_RESOLVER) dnsResolver?: DnsResolver,
    @Optional() private readonly oauth?: OutreachOAuthService,
  ) {
    this.dns = dnsResolver ?? DEFAULT_DNS_RESOLVER;
  }

  /** 当前默认发件信箱 + 今日/本周用量 + warmup 阶梯上限（优先返回已配凭据的 BYO 信箱）。 */
  async summary(tenant: OutreachTenant, now: Date = new Date()) {
    const byo = await this.findActiveByoMailbox(tenant.workspaceId).catch(() => null);
    const mailbox =
      byo ??
      (await this.ensureDefaultMailbox(
        tenant.workspaceId,
        this.config.OUTREACH_SMTP_FROM_ADDRESS,
        {
          dailyCap: this.config.OUTREACH_MAILBOX_DAILY_CAP,
          weeklyCap: this.config.OUTREACH_MAILBOX_WEEKLY_CAP,
        },
      ));
    if (!mailbox) return { mailbox: null, usage: null, warmupCaps: null };
    const usage = await this.usage(tenant.workspaceId, mailbox.id, now);
    return {
      mailbox: sanitizeMailboxRow(mailbox),
      usage,
      warmupCaps:
        WARMUP_STAGE_CAPS[mailbox.warmupStage as WarmupStage] ?? WARMUP_STAGE_CAPS.MATURE,
    };
  }

  /** 查找工作空间中已配置加密凭据的活跃 BYO 信箱（支持按指定 mailboxId 精确加载）。 */
  async findActiveByoMailbox(workspaceId: string, preferredMailboxId?: string | null) {
    return this.prisma.withWorkspace(workspaceId, async (tx) => {
      if (preferredMailboxId && UUID_RE.test(preferredMailboxId)) {
        const chosen = await tx.outreachMailbox.findFirst({
          where: { id: preferredMailboxId, workspaceId },
        });
        if (chosen) return chosen;
      }
      const list = await tx.outreachMailbox.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'asc' },
      });
      return (
        list.find(
          (row) =>
            row.state === 'ACTIVE' &&
            Boolean((row as { credentialsCiphertext?: string | null }).credentialsCiphertext) &&
            Boolean((row as { smtpHost?: string | null }).smtpHost),
        ) ?? null
      );
    });
  }

  /** 解析指定信箱的动态 SMTP 发信凭据（仅内存中解密，若为 OAuth2 则自动续期）。 */
  async resolveSmtpCredentialsForMailbox(
    workspaceId: string,
    mailbox: {
      id: string;
      address: string;
      displayName: string;
      authMode?: string;
      smtpHost?: string | null;
      smtpPort?: number | null;
      smtpSecure?: boolean;
      credentialsCiphertext?: string | null;
    },
  ): Promise<OutreachSmtpCredentials | null> {
    if (!mailbox.smtpHost || !mailbox.credentialsCiphertext) return null;
    if (!this.crypto) {
      throw new Error('PiiCryptoService 不可用，无法解密 BYO 发信箱凭据');
    }
    const raw = this.crypto.decryptSecret(
      workspaceId,
      mailbox.credentialsCiphertext,
      OUTREACH_PII_PURPOSE.MAILBOX_CREDENTIALS,
    );
    let bundle = JSON.parse(raw) as StoredMailboxCredentials;
    if (
      this.oauth &&
      (bundle.authMode === 'oauth_google' || bundle.authMode === 'oauth_m365')
    ) {
      bundle = await this.oauth.refreshOAuthCredentialsIfNeeded(workspaceId, mailbox.id, bundle);
    }
    return {
      host: mailbox.smtpHost,
      port: mailbox.smtpPort ?? (mailbox.smtpSecure ? 465 : 587),
      secure: Boolean(mailbox.smtpSecure),
      starttls: !mailbox.smtpSecure,
      fromAddress: mailbox.address,
      fromName: mailbox.displayName || mailbox.address.split('@')[0] || '',
      authMode: bundle.authMode,
      user: bundle.username || mailbox.address,
      password: bundle.password,
      accessToken: bundle.accessToken,
    };
  }

  /** 懒创建并返回当前发件信箱（单信箱降级模式的落库化）；未配置地址时返回 null。 */
  async ensureDefaultMailbox(
    workspaceId: string,
    fromAddress: string | undefined,
    options: { dailyCap?: number; weeklyCap?: number } = {},
  ) {
    if (!fromAddress || !EMAIL_RE.test(fromAddress)) return null;
    const address = fromAddress.trim().toLowerCase();
    return this.prisma.withWorkspace(workspaceId, async (tx) => {
      const domain = await this.ensureDomainTx(tx, workspaceId, domainOf(address), 'cold_outbound');
      const existing = await tx.outreachMailbox.findUnique({
        where: { workspaceId_address: { workspaceId, address } },
      });
      if (existing) return existing;
      try {
        return await tx.outreachMailbox.create({
          data: {
            workspaceId,
            domainId: domain.id,
            address,
            displayName: address.split('@')[0] ?? address,
            provider: 'smtp',
            warmupStage: 'MATURE',
            dailyCap: options.dailyCap ?? 30,
            weeklyCap: options.weeklyCap ?? 120,
            timezone: 'Europe/Berlin',
            state: 'ACTIVE',
            healthState: 'CLOSED',
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          return tx.outreachMailbox.findUnique({
            where: { workspaceId_address: { workspaceId, address } },
          });
        }
        throw error;
      }
    });
  }

  /** 当前日/周已发送数（来自落库计数，P4-02）。 */
  async usage(workspaceId: string, mailboxId: string, now: Date): Promise<OutboxUsage> {
    const day = utcDay(now);
    const weekStart = new Date(day.getTime() - 6 * 86_400_000);
    const [today, week] = await this.prisma.withWorkspace(workspaceId, (tx) =>
      Promise.all([
        tx.outreachMailboxCounter.findFirst({
          where: { workspaceId, mailboxId, day },
        }),
        tx.outreachMailboxCounter.aggregate({
          where: { workspaceId, mailboxId, day: { gte: weekStart } },
          _sum: { sent: true },
        }),
      ]),
    );
    return { dailySent: today?.sent ?? 0, weeklySent: week._sum.sent ?? 0 };
  }

  /** 一封发送成功后原子递增日计数与「发件域×收件域」小时计数。 */
  async recordSend(
    mailbox: { id: string; domainId: string; workspaceId: string },
    recipientEmail: string,
    now: Date,
  ): Promise<void> {
    const day = utcDay(now);
    const hour = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        now.getUTCHours(),
      ),
    );
    const recipientDomain = recipientDomainOf(recipientEmail);
    await this.prisma.withWorkspace(mailbox.workspaceId, (tx) =>
      Promise.all([
        tx.outreachMailboxCounter.upsert({
          where: { mailboxId_day: { mailboxId: mailbox.id, day } },
          create: { workspaceId: mailbox.workspaceId, mailboxId: mailbox.id, day, sent: 1 },
          update: { sent: { increment: 1 } },
        }),
        tx.outreachDomainCounter.upsert({
          where: {
            domainId_hour_recipientDomain: {
              domainId: mailbox.domainId,
              hour,
              recipientDomain,
            },
          },
          create: {
            workspaceId: mailbox.workspaceId,
            domainId: mailbox.domainId,
            hour,
            recipientDomain,
            sent: 1,
          },
          update: { sent: { increment: 1 } },
        }),
        tx.outreachMailbox.update({
          where: { id: mailbox.id },
          data: { lastSendAt: now },
        }),
      ]),
    );
  }

  /** 硬拒绝（5xx）记入信箱当日计数，供未来按信箱熔断读取。 */
  async recordHardBounce(workspaceId: string, mailboxId: string, now: Date): Promise<void> {
    const day = utcDay(now);
    await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.outreachMailboxCounter.upsert({
        where: { mailboxId_day: { mailboxId, day } },
        create: { workspaceId, mailboxId, day, hardBounces: 1 },
        update: { hardBounces: { increment: 1 } },
      }),
    );
  }

  async listMailboxes(tenant: OutreachTenant): Promise<SanitizedMailboxView[]> {
    const rows = await this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
      tx.outreachMailbox.findMany({
        where: { workspaceId: tenant.workspaceId },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return rows.map(sanitizeMailboxRow);
  }

  async createMailbox(tenant: OutreachTenant, input: OutreachMailboxInput): Promise<SanitizedMailboxView> {
    const normalized = this.normalize(input, { partial: false });
    try {
      const mailbox = await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
        const domain = await this.ensureDomainTx(tx, tenant.workspaceId, domainOf(normalized.address));
        return tx.outreachMailbox.create({
          data: {
            workspaceId: tenant.workspaceId,
            domainId: domain.id,
            address: normalized.address,
            displayName: normalized.displayName ?? '',
            provider: normalized.provider ?? 'smtp',
            warmupStage: normalized.warmupStage ?? 'W1',
            dailyCap: normalized.dailyCap ?? this.config.OUTREACH_MAILBOX_DAILY_CAP,
            weeklyCap: normalized.weeklyCap ?? this.config.OUTREACH_MAILBOX_WEEKLY_CAP,
            timezone: normalized.timezone ?? 'Europe/Berlin',
            state: normalized.state ?? 'ACTIVE',
          },
        });
      });
      await this.audit.record({
        realm: 'tenant',
        actorId: tenant.userId,
        workspaceId: tenant.workspaceId,
        action: 'outreach.mailbox.created',
        target: mailbox.id,
        detail: { address: mailbox.address, warmupStage: mailbox.warmupStage },
      });
      return sanitizeMailboxRow(mailbox);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        conflict('OUTREACH_MAILBOX_DUPLICATE', '该发件信箱已存在');
      }
      throw error;
    }
  }

  async updateMailbox(
    tenant: OutreachTenant,
    mailboxId: string,
    input: OutreachMailboxInput,
  ): Promise<SanitizedMailboxView> {
    if (!UUID_RE.test(mailboxId)) notFound();
    const updated = await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
      const existing = await tx.outreachMailbox.findFirst({
        where: { id: mailboxId, workspaceId: tenant.workspaceId },
      });
      if (!existing) notFound();
      const normalized = this.normalize(input, { partial: true });
      if (normalized.address && normalized.address !== existing.address) {
        invalid('不允许修改发件地址；请新建信箱并停用旧信箱');
      }
      return tx.outreachMailbox.update({
        where: { id: mailboxId },
        data: {
          ...(normalized.displayName !== undefined
            ? { displayName: normalized.displayName }
            : {}),
          ...(normalized.provider !== undefined ? { provider: normalized.provider } : {}),
          ...(normalized.warmupStage !== undefined
            ? { warmupStage: normalized.warmupStage }
            : {}),
          ...(normalized.dailyCap !== undefined ? { dailyCap: normalized.dailyCap } : {}),
          ...(normalized.weeklyCap !== undefined ? { weeklyCap: normalized.weeklyCap } : {}),
          ...(normalized.timezone !== undefined ? { timezone: normalized.timezone } : {}),
          ...(normalized.state !== undefined ? { state: normalized.state } : {}),
        },
      });
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      workspaceId: tenant.workspaceId,
      action: 'outreach.mailbox.updated',
      target: mailboxId,
      detail: {
        warmupStage: updated.warmupStage,
        state: updated.state,
        dailyCap: updated.dailyCap,
        weeklyCap: updated.weeklyCap,
      },
    });
    return sanitizeMailboxRow(updated);
  }

  /**
   * 加密存储租户 BYO 发信箱凭据（POST /api/outreach/mailboxes/:id/credentials）：
   * 校验主机与端口防 SSRF → 按租户 HKDF DEK + workspaceId AAD 加密 → 永不回显明文或密文。
   */
  async configureCredentials(
    tenant: OutreachTenant,
    mailboxId: string,
    input: ConfigureMailboxCredentialsInput,
  ): Promise<SanitizedMailboxView> {
    if (!UUID_RE.test(mailboxId)) notFound();
    if (!this.crypto) {
      throw new BadRequestException({
        error: { code: 'PII_CRYPTO_NOT_CONFIGURED', message: '未初始化加密服务' },
      });
    }
    this.crypto.requireKeyring();

    const authMode: MailboxAuthMode = input.authMode ?? 'password';
    if (!(MAILBOX_AUTH_MODES as readonly string[]).includes(authMode)) {
      invalid('authMode 必须是 password / oauth_google / oauth_m365');
    }

    const allowPrivate = this.config.OUTREACH_BYO_ALLOW_PRIVATE_HOSTS === true;
    const safeSmtp = assertSafeMailHost(input.smtpHost, input.smtpPort, 'smtp', { allowPrivate });
    const smtpSecure = input.smtpSecure ?? safeSmtp.port === 465;

    let safeImap: { host: string; port: number } | null = null;
    if (input.imapHost && input.imapHost.trim()) {
      const imapPort = input.imapPort ?? 993;
      safeImap = assertSafeMailHost(input.imapHost, imapPort, 'imap', { allowPrivate });
    }
    const imapSecure = input.imapSecure ?? (safeImap ? safeImap.port === 993 : true);
    const imapMailbox = (input.imapMailbox?.trim() || 'INBOX').slice(0, 128);

    if (authMode === 'password') {
      if (!input.password || !input.password.trim()) {
        invalid('密码模式下 SMTP 密码/应用专用密码必填');
      }
    } else if (!input.oauthAccessToken?.trim() && !input.oauthRefreshToken?.trim()) {
      invalid('OAuth 模式必须提供访问令牌或刷新令牌');
    }

    const oauthTokenExpiresAt = input.oauthTokenExpiresAt
      ? new Date(input.oauthTokenExpiresAt)
      : null;
    if (oauthTokenExpiresAt && Number.isNaN(oauthTokenExpiresAt.getTime())) {
      invalid('oauthTokenExpiresAt 不是合法时间');
    }

    const now = new Date();
    const updated = await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
      const existing = await tx.outreachMailbox.findFirst({
        where: { id: mailboxId, workspaceId: tenant.workspaceId },
      });
      if (!existing) notFound();

      const bundle: StoredMailboxCredentials = {
        authMode,
        username: (input.username?.trim() || existing.address).slice(0, 320),
        ...(authMode === 'password'
          ? {
              password: input.password,
              ...(input.imapUsername?.trim() ? { imapUsername: input.imapUsername.trim().slice(0, 320) } : {}),
              ...(input.imapPassword ? { imapPassword: input.imapPassword } : {}),
            }
          : {
              accessToken: input.oauthAccessToken,
              refreshToken: input.oauthRefreshToken,
              expiresAt: oauthTokenExpiresAt?.toISOString(),
            }),
      };

      const { ciphertext, keyId } = this.crypto!.encryptSecret(
        tenant.workspaceId,
        JSON.stringify(bundle),
        OUTREACH_PII_PURPOSE.MAILBOX_CREDENTIALS,
      );

      return tx.outreachMailbox.update({
        where: { id: existing.id },
        data: {
          authMode,
          smtpHost: safeSmtp.host,
          smtpPort: safeSmtp.port,
          smtpSecure,
          imapHost: safeImap?.host ?? null,
          imapPort: safeImap?.port ?? null,
          imapSecure,
          imapMailbox,
          credentialsCiphertext: ciphertext,
          credentialsKeyId: keyId,
          credentialsUpdatedAt: now,
          oauthTokenExpiresAt,
          lastVerifyStatus: null,
          lastVerifyError: null,
        },
      });
    });

    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      workspaceId: tenant.workspaceId,
      action: 'outreach.mailbox.credentials_updated',
      target: mailboxId,
      detail: {
        authMode,
        smtpHost: safeSmtp.host,
        smtpPort: safeSmtp.port,
        imapConfigured: Boolean(safeImap),
        keyId: updated.credentialsKeyId,
      },
    });

    return sanitizeMailboxRow(updated);
  }

  /** 删除租户 BYO 发信箱（同时清除关联密文凭据与计数），仅管理员可调用。 */
  async deleteMailbox(tenant: OutreachTenant, mailboxId: string): Promise<{ deleted: true; id: string }> {
    if (!UUID_RE.test(mailboxId)) notFound();
    const deletedAddress = await this.prisma.withWorkspace(tenant.workspaceId, async (tx) => {
      const existing = await tx.outreachMailbox.findFirst({
        where: { id: mailboxId, workspaceId: tenant.workspaceId },
        select: { id: true, address: true },
      });
      if (!existing) notFound();
      await tx.outreachMailbox.delete({ where: { id: existing.id } });
      return existing.address;
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      workspaceId: tenant.workspaceId,
      action: 'outreach.mailbox.deleted',
      target: mailboxId,
      detail: { address: deletedAddress },
    });
    return { deleted: true, id: mailboxId };
  }

  /**
   * BYO 发信箱实时连通性自检（POST /api/outreach/mailboxes/:id/test-connection）：
   * 校验 SMTP 握手+认证（不发邮件）及可选 IMAP 登录，记录核验时间与结果并绝不回显凭据。
   */
  async testConnection(tenant: OutreachTenant, mailboxId: string): Promise<{
    mailboxId: string;
    ready: boolean;
    smtp: { ok: boolean; latencyMs?: number; error?: string };
    imap: { ok: boolean; skipped?: boolean; latencyMs?: number; error?: string };
    verifiedAt: string;
  }> {
    if (!UUID_RE.test(mailboxId)) notFound();
    const mailbox = await this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
      tx.outreachMailbox.findFirst({
        where: { id: mailboxId, workspaceId: tenant.workspaceId },
      }),
    );
    if (!mailbox) notFound();
    if (!mailbox.smtpHost || !mailbox.credentialsCiphertext) {
      invalid('该信箱尚未配置 SMTP 主机或凭据，请先保存凭据后再测试连通性');
    }

    const smtpCreds = await this.resolveSmtpCredentialsForMailbox(tenant.workspaceId, mailbox);
    if (!smtpCreds) {
      invalid('无法解析发信箱凭据');
    }

    let smtpOutcome: { ok: boolean; latencyMs?: number; error?: string };
    if (!this.transport?.testConnection) {
      smtpOutcome = { ok: false, error: '当前传输层不支持连通性测试' };
    } else {
      try {
        const res = await this.transport.testConnection(smtpCreds);
        smtpOutcome = { ok: true, latencyMs: res.latencyMs };
      } catch (err) {
        smtpOutcome = {
          ok: false,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        };
      }
    }

    let imapOutcome: { ok: boolean; skipped?: boolean; latencyMs?: number; error?: string };
    if (!mailbox.imapHost) {
      imapOutcome = { ok: true, skipped: true };
    } else if (!this.imapClient?.testConnection) {
      imapOutcome = { ok: true, skipped: true };
    } else {
      try {
        const raw = this.crypto!.decryptSecret(
          tenant.workspaceId,
          mailbox.credentialsCiphertext,
          OUTREACH_PII_PURPOSE.MAILBOX_CREDENTIALS,
        );
        const bundle = JSON.parse(raw) as StoredMailboxCredentials;
        const imapCreds: OutreachImapCredentials = {
          host: mailbox.imapHost,
          port: mailbox.imapPort ?? 993,
          secure: mailbox.imapSecure,
          mailbox: mailbox.imapMailbox || 'INBOX',
          authMode: smtpCreds.authMode,
          user: bundle.imapUsername || smtpCreds.user || mailbox.address,
          password: bundle.imapPassword ?? smtpCreds.password,
          accessToken: smtpCreds.accessToken,
        };
        const res = await this.imapClient.testConnection(imapCreds);
        imapOutcome = { ok: true, latencyMs: res.latencyMs };
      } catch (err) {
        imapOutcome = {
          ok: false,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        };
      }
    }

    const ready = smtpOutcome.ok && imapOutcome.ok;
    const now = new Date();
    const combinedError = [
      !smtpOutcome.ok ? `SMTP: ${smtpOutcome.error}` : null,
      !imapOutcome.ok ? `IMAP: ${imapOutcome.error}` : null,
    ]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 500);

    await this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
      tx.outreachMailbox.update({
        where: { id: mailbox.id },
        data: {
          lastVerifiedAt: now,
          lastVerifyStatus: ready ? 'OK' : 'FAILED',
          lastVerifyError: ready ? null : combinedError || 'CONNECT_FAILED',
        },
      }),
    );

    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      workspaceId: tenant.workspaceId,
      action: 'outreach.mailbox.connection_tested',
      target: mailbox.id,
      detail: { ready, smtpOk: smtpOutcome.ok, imapOk: imapOutcome.ok, imapSkipped: Boolean(imapOutcome.skipped) },
    });

    return {
      mailboxId: mailbox.id,
      ready,
      smtp: smtpOutcome,
      imap: imapOutcome,
      verifiedAt: now.toISOString(),
    };
  }

  /** 列出工作空间下全部发信域及最近 DNS 核验快照。 */
  async listDomains(tenant: OutreachTenant) {
    return this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
      tx.outreachDomain.findMany({
        where: { workspaceId: tenant.workspaceId },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  /**
   * 真实 DNS 核验（POST /api/outreach/domains/:id/verify-dns）：
   * 复用 #214 `inspectSenderDomain` + `evaluateDomainDnsAdvice` + `dnsRecordTemplate`，
   * 并将 SPF/DKIM/DMARC/MX 检查快照落库到 `outreach_domain`。
   */
  async verifyDomainDns(
    tenant: OutreachTenant,
    domainId: string,
    rawSelector?: string,
  ) {
    if (!UUID_RE.test(domainId)) domainNotFound();
    const domainRow = await this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
      tx.outreachDomain.findFirst({
        where: { id: domainId, workspaceId: tenant.workspaceId },
      }),
    );
    if (!domainRow) domainNotFound();

    const selector = (rawSelector?.trim() || domainRow.dkimSelector || 'google');
    if (!DKIM_SELECTOR_RE.test(selector)) {
      invalid('dkimSelector 格式不合法');
    }

    const report = await inspectSenderDomain(domainRow.domain, this.dns, { dkimSelector: selector });
    const advice = evaluateDomainDnsAdvice(report);
    const template = dnsRecordTemplate(domainRow.domain, { dkimSelector: selector });
    const now = new Date();

    const updated = await this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
      tx.outreachDomain.update({
        where: { id: domainRow.id },
        data: {
          dkimSelector: selector,
          dnsVerifiedAt: now,
          dnsReady: report.ready,
          dnsReport: report as unknown as Prisma.InputJsonValue,
        },
      }),
    );

    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      workspaceId: tenant.workspaceId,
      action: 'outreach.domain.dns_verified',
      target: domainRow.id,
      detail: { domain: domainRow.domain, selector, ready: report.ready, ok: report.ok },
    });

    return {
      domain: updated,
      report,
      advice,
      template,
    };
  }

  private async ensureDomainTx(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    domain: string,
    kind = 'cold_outbound',
  ) {
    return tx.outreachDomain.upsert({
      where: { workspaceId_domain: { workspaceId, domain } },
      create: { workspaceId, domain, kind, state: 'ACTIVE' },
      update: {},
    });
  }

  private normalize(input: OutreachMailboxInput, options: { partial: boolean }) {
    const address = typeof input.address === 'string' ? input.address.trim().toLowerCase() : '';
    if (!options.partial || input.address !== undefined) {
      if (!EMAIL_RE.test(address) || address.length > 320) invalid('发件邮箱不合法');
    }
    const displayName =
      typeof input.displayName === 'string' ? input.displayName.trim() : undefined;
    if (!options.partial || input.displayName !== undefined) {
      if (!displayName || displayName.length > 200) invalid('显示名必填且不超过 200 字');
    }
    let provider: string | undefined;
    if (input.provider !== undefined) {
      provider = typeof input.provider === 'string' ? input.provider.trim().slice(0, 32) : '';
      if (!provider) invalid('provider 不合法');
    } else if (!options.partial) {
      provider = 'smtp';
    }

    let warmupStage: WarmupStage | undefined;
    if (input.warmupStage !== undefined) {
      if (
        typeof input.warmupStage !== 'string' ||
        !(WARMUP_STAGES as readonly string[]).includes(input.warmupStage)
      ) {
        invalid('warmupStage 必须是 W1/W2/W3/MATURE');
      }
      warmupStage = input.warmupStage as WarmupStage;
    } else if (!options.partial) {
      warmupStage = 'W1';
    }
    const stageCaps = WARMUP_STAGE_CAPS[warmupStage ?? 'W1'];
    const capsDefault = options.partial && warmupStage === undefined ? undefined : stageCaps;
    const dailyCap =
      input.dailyCap !== undefined
        ? this.positiveInt(input.dailyCap, stageCaps.daily, 'dailyCap', 500)
        : capsDefault?.daily;
    const weeklyCap =
      input.weeklyCap !== undefined
        ? this.positiveInt(input.weeklyCap, stageCaps.weekly, 'weeklyCap', 2000)
        : capsDefault?.weekly;
    let timezone: string | undefined;
    if (input.timezone !== undefined) {
      if (typeof input.timezone !== 'string' || !input.timezone.trim()) {
        invalid('timezone 不合法');
      }
      timezone = input.timezone.trim().slice(0, 64);
    } else if (!options.partial) {
      timezone = 'Europe/Berlin';
    }
    let state: MailboxState | undefined;
    if (input.state !== undefined) {
      if (
        typeof input.state !== 'string' ||
        !(MAILBOX_STATES as readonly string[]).includes(input.state)
      ) {
        invalid('state 必须是 ACTIVE/PAUSED/RETIRED');
      }
      state = input.state as MailboxState;
    } else if (!options.partial) {
      state = 'ACTIVE';
    }
    return {
      address,
      displayName,
      provider,
      warmupStage,
      dailyCap,
      weeklyCap,
      timezone,
      state,
    };
  }

  private positiveInt(value: unknown, fallback: number, name: string, max: number): number {
    if (value === undefined || value === null) return fallback;
    const num = Number(value);
    if (!Number.isInteger(num) || num < 1 || num > max) {
      invalid(`${name} 必须是 1..${max} 的整数`);
    }
    return num;
  }
}

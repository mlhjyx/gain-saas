import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PiiCryptoService } from '../shared/pii-crypto.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import { resolveAndAssertSafeMailHost } from './outreach-host-guard.js';
import { OutreachIngestService } from './outreach-ingest.service.js';
import { OutreachOAuthService } from './outreach-oauth.service.js';
import {
  OUTREACH_PII_PURPOSE,
  type MailboxAuthMode,
  type StoredMailboxCredentials,
} from './outreach-pii.constants.js';

export const OUTREACH_IMAP_CLIENT = Symbol('OUTREACH_IMAP_CLIENT');

export interface OutreachImapMessage {
  uid: number;
  raw: string;
}

/** 单租户 BYO IMAP 连接凭据（内存中按租户 DEK 解密，绝不跨租户复用）。 */
export interface OutreachImapCredentials {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly mailbox: string;
  readonly authMode: MailboxAuthMode;
  readonly user: string;
  readonly password?: string;
  readonly accessToken?: string;
}

/**
 * 极窄的 IMAP 客户端接口：支持按租户 BYO 凭据连接或兼容单信箱配置，提供取未读、标已读与连通性自检。
 */
export interface OutreachImapClient {
  fetchUnseen(
    account: string,
    credentials?: OutreachImapCredentials,
  ): Promise<OutreachImapMessage[]>;
  markSeen(
    account: string,
    uid: number,
    credentials?: OutreachImapCredentials,
  ): Promise<void>;
  testConnection?(
    credentials: OutreachImapCredentials,
  ): Promise<{ ok: true; latencyMs: number }>;
}

/**
 * imapflow 多租户 BYO 适配器：
 * - 传入 credentials 时使用该租户独立主机、端口与认证（密码或 OAuth2 accessToken），并执行 SSRF 校验；
 * - 未传入 credentials 时保持旧单信箱 env 降级路径。
 */
@Injectable()
export class ImapFlowClient implements OutreachImapClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private async withClient<T>(
    credentials: OutreachImapCredentials | undefined,
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    let host: string;
    let port: number;
    let secure: boolean;
    let mailboxName: string;
    let auth: { user: string; pass?: string; accessToken?: string };

    if (credentials) {
      const checked = await resolveAndAssertSafeMailHost(
        credentials.host,
        credentials.port,
        'imap',
        { allowPrivate: this.config.OUTREACH_BYO_ALLOW_PRIVATE_HOSTS === true },
      );
      host = checked.resolvedAddress ?? checked.host;
      port = checked.port;
      secure = credentials.secure;
      mailboxName = credentials.mailbox || 'INBOX';
      auth =
        credentials.authMode === 'password'
          ? { user: credentials.user, pass: credentials.password }
          : { user: credentials.user, accessToken: credentials.accessToken };
    } else {
      if (!this.config.OUTREACH_IMAP_HOST || !this.config.OUTREACH_IMAP_USER) {
        throw new Error('IMAP 未配置（OUTREACH_IMAP_HOST/OUTREACH_IMAP_USER）');
      }
      host = this.config.OUTREACH_IMAP_HOST;
      port = this.config.OUTREACH_IMAP_PORT;
      secure = true;
      mailboxName = this.config.OUTREACH_IMAP_MAILBOX;
      auth = {
        user: this.config.OUTREACH_IMAP_USER,
        pass: this.config.OUTREACH_IMAP_PASSWORD,
      };
    }

    const client = new ImapFlow({
      host,
      port,
      secure,
      // 143 端口非直连 TLS 模式强制要求 STARTTLS 升级，拒绝明文传输凭据（防降级攻击）
      ...(!secure ? { doSTARTTLS: true } : {}),
      auth,
      tls: {
        servername: credentials?.host ?? host,
        rejectUnauthorized: this.config.OUTREACH_SMTP_TLS_REJECT_UNAUTHORIZED,
      },
      logger: false,
    });
    await client.connect();
    try {
      if (!client.secureConnection) {
        throw new Error('IMAP 服务器未启用 TLS/STARTTLS 加密通道，已拒绝拉取');
      }
      const lock = await client.getMailboxLock(mailboxName);
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  async fetchUnseen(
    _account: string,
    credentials?: OutreachImapCredentials,
  ): Promise<OutreachImapMessage[]> {
    return this.withClient(credentials, async (client) => {
      const messages: OutreachImapMessage[] = [];
      for await (const message of client.fetch({ seen: false }, { source: true, uid: true })) {
        if (!message.source) continue;
        messages.push({ uid: message.uid, raw: message.source.toString('utf8') });
      }
      return messages;
    });
  }

  async markSeen(
    _account: string,
    uid: number,
    credentials?: OutreachImapCredentials,
  ): Promise<void> {
    await this.withClient(credentials, async (client) => {
      await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
    });
  }

  async testConnection(
    credentials: OutreachImapCredentials,
  ): Promise<{ ok: true; latencyMs: number }> {
    const startedAt = Date.now();
    await this.withClient(credentials, async () => undefined);
    return { ok: true, latencyMs: Date.now() - startedAt };
  }
}

export interface ImapPollSummary {
  processed: number;
  duplicates: number;
  unmatched: number;
  errors: number;
}

interface ActiveByoImapRow {
  id?: string;
  workspace_id: string;
  address: string;
  auth_mode?: string;
  imap_host?: string | null;
  imap_port?: number | null;
  imap_secure?: boolean | null;
  imap_mailbox?: string | null;
  credentials_ciphertext?: string | null;
  oauth_token_expires_at?: Date | null;
}

/**
 * 多租户隔离 IMAP 入站轮询器（M9-PR2）：
 * - 对配置了 BYO 凭据的发信箱，逐租户解密独立 IMAP 凭据（含 OAuth2 令牌静默续期）并隔离拉取；
 * - 隔离 BYO 信箱内所有已处理邮件（含 UNMATCHED）均安全标 \Seen，根治跨租户 UNMATCHED 污染与不标 \Seen 死循环；
 * - 兼容历史未配置 BYO 凭据的单租户/单测模式。
 */
@Injectable()
export class OutreachImapPoller implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutreachImapPoller.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: OutreachIngestService,
    @Inject(OUTREACH_IMAP_CLIENT) private readonly client: OutreachImapClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() private readonly crypto?: PiiCryptoService,
    @Optional() private readonly oauth?: OutreachOAuthService,
  ) {}

  onModuleInit(): void {
    if (!this.config.OUTREACH_IMAP_ENABLED) return;
    this.timer = setInterval(() => {
      void this.pollOnce().catch(() => undefined);
    }, this.config.OUTREACH_IMAP_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async resolveByoCredentials(
    row: ActiveByoImapRow,
  ): Promise<OutreachImapCredentials | undefined> {
    if (!row.imap_host || !row.credentials_ciphertext) return undefined;
    if (!this.crypto?.enabled) {
      throw new Error('PII_KEYRING_JSON 未配置，无法解密租户 IMAP 凭据');
    }
    const raw = this.crypto.decryptSecret(
      row.workspace_id,
      row.credentials_ciphertext,
      OUTREACH_PII_PURPOSE.MAILBOX_CREDENTIALS,
    );
    let bundle = JSON.parse(raw) as StoredMailboxCredentials;
    if (
      this.oauth &&
      row.id &&
      (bundle.authMode === 'oauth_google' || bundle.authMode === 'oauth_m365')
    ) {
      bundle = await this.oauth.refreshOAuthCredentialsIfNeeded(row.workspace_id, row.id, bundle);
    }
    return {
      host: row.imap_host,
      port: row.imap_port ?? 993,
      secure: row.imap_secure ?? true,
      mailbox: row.imap_mailbox || 'INBOX',
      authMode: bundle.authMode,
      user: bundle.imapUsername || bundle.username || row.address,
      password: bundle.imapPassword ?? bundle.password,
      accessToken: bundle.accessToken,
    };
  }

  async pollOnce(): Promise<ImapPollSummary> {
    const summary: ImapPollSummary = { processed: 0, duplicates: 0, unmatched: 0, errors: 0 };
    const rows = await this.prisma.$queryRaw<ActiveByoImapRow[]>`
      SELECT
        id, workspace_id, address, auth_mode, imap_host, imap_port,
        imap_secure, imap_mailbox, credentials_ciphertext, oauth_token_expires_at
      FROM public.app_list_byo_imap_mailboxes()
    `;

    const hasGlobalImapEnv = Boolean(this.config.OUTREACH_IMAP_HOST);
    const legacyWorkspaces = new Set(
      rows
        .filter((r) => !r.credentials_ciphertext && !r.imap_host)
        .map((r) => r.workspace_id),
    );
    const legacyMultiTenant = legacyWorkspaces.size > 1;

    for (const row of rows) {
      const hasByoCreds = Boolean(row.credentials_ciphertext);
      const isIsolatedByo = hasByoCreds && Boolean(row.imap_host);
      // 关键安全边界：仅配置 SMTP 未配 IMAP 的 BYO 信箱绝不能回落平台共享 env IMAP，防止跨租户串信！
      if (hasByoCreds && !row.imap_host) {
        continue;
      }
      // 历史非 BYO 行仅在显式配置了平台全局 OUTREACH_IMAP_HOST 时走兼容通道
      if (!isIsolatedByo && !hasGlobalImapEnv) {
        continue;
      }
      let credentials: OutreachImapCredentials | undefined;
      if (isIsolatedByo) {
        try {
          credentials = await this.resolveByoCredentials(row);
        } catch (err) {
          summary.errors += 1;
          this.logger.warn(
            `BYO IMAP 凭据解密/续期失败 workspace=${row.workspace_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
      }

      let messages: OutreachImapMessage[];
      try {
        messages = await this.client.fetchUnseen(row.address, credentials);
      } catch {
        summary.errors += 1;
        continue;
      }

      for (const message of messages) {
        try {
          const result = await this.ingest.ingest(
            { userId: 'imap-ingest', workspaceId: row.workspace_id, role: 'admin' },
            message.raw,
          );
          if (result.outcome === 'DUPLICATE') summary.duplicates += 1;
          else if (result.outcome === 'UNMATCHED') summary.unmatched += 1;
          else summary.processed += 1;

          // 隔离 BYO 信箱归属单一租户：所有处理完的邮件（含 UNMATCHED）都立即标 \Seen，
          // 根治不标 \Seen 反复重扫死循环；仅历史共享全局邮箱保留防跨租户吞信守卫。
          if (isIsolatedByo || !legacyMultiTenant || result.outcome !== 'UNMATCHED') {
            await this.client.markSeen(row.address, message.uid, credentials);
          }
        } catch {
          summary.errors += 1;
        }
      }
    }
    return summary;
  }
}

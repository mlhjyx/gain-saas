import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../config/configuration.js';
import { AuditService } from '../shared/audit.service.js';
import { APP_CONFIG } from '../shared/config.module.js';
import { PiiCryptoService } from '../shared/pii-crypto.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import {
  OUTREACH_PII_PURPOSE,
  sanitizeMailboxRow,
  type SanitizedMailboxView,
  type StoredMailboxCredentials,
} from './outreach-pii.constants.js';

export type OutreachOAuthProvider = 'google' | 'm365';

export const OUTREACH_OAUTH_HTTP_CLIENT = Symbol('OUTREACH_OAUTH_HTTP_CLIENT');

export interface OAuthTokenResponse {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn?: number;
  readonly tokenType?: string;
  readonly scope?: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
}

export interface OutreachOAuthHttpClient {
  exchangeCode(input: {
    provider: OutreachOAuthProvider;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
  }): Promise<OAuthTokenResponse>;
  refreshToken(input: {
    provider: OutreachOAuthProvider;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<OAuthTokenResponse>;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const OAUTH_STATE_GLOBAL_SCOPE = 'oauth-state-v2';

const GOOGLE_SCOPES = [
  'https://mail.google.com/',
  'openid',
  'email',
].join(' ');

const M365_SCOPES = [
  'offline_access',
  'openid',
  'email',
  'https://outlook.office.com/SMTP.Send',
  'https://outlook.office.com/IMAP.AccessAsUser.All',
].join(' ');

const PROVIDER_MAIL_DEFAULTS: Record<
  OutreachOAuthProvider,
  {
    authMode: 'oauth_google' | 'oauth_m365';
    provider: string;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    imapHost: string;
    imapPort: number;
    imapSecure: boolean;
  }
> = {
  google: {
    authMode: 'oauth_google',
    provider: 'google_workspace',
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpSecure: true,
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    imapSecure: true,
  },
  m365: {
    authMode: 'oauth_m365',
    provider: 'microsoft_365',
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    smtpSecure: false,
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    imapSecure: true,
  },
};

function decodeJwtEmail(idToken?: string): { email?: string; emailVerified?: boolean } {
  if (!idToken || typeof idToken !== 'string') return {};
  const parts = idToken.split('.');
  if (parts.length < 2) return {};
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const rawEmail = payload.email ?? payload.preferred_username ?? payload.upn;
    const email =
      typeof rawEmail === 'string' && rawEmail.includes('@')
        ? rawEmail.trim().toLowerCase()
        : undefined;
    // 若声明中显式携带 email_verified=false，必须判为未验证（fail-closed）
    const emailVerified =
      payload.email_verified === undefined ? undefined : payload.email_verified === true;
    return { email, emailVerified };
  } catch {
    return {};
  }
}

export class FetchOutreachOAuthHttpClient implements OutreachOAuthHttpClient {
  async exchangeCode(input: {
    provider: OutreachOAuthProvider;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
  }): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      code: input.code,
    });
    return this.postToken(input.tokenUrl, body);
  }

  async refreshToken(input: {
    provider: OutreachOAuthProvider;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
    });
    return this.postToken(input.tokenUrl, body);
  }

  private async postToken(tokenUrl: string, body: URLSearchParams): Promise<OAuthTokenResponse> {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !json || typeof json.access_token !== 'string') {
      const errDesc =
        (typeof json?.error_description === 'string' && json.error_description) ||
        (typeof json?.error === 'string' && json.error) ||
        `HTTP ${response.status}`;
      throw new BadRequestException({
        error: { code: 'OUTREACH_OAUTH_TOKEN_EXCHANGE_FAILED', message: `OAuth 令牌换取失败：${errDesc}` },
      });
    }
    const identity = decodeJwtEmail(typeof json.id_token === 'string' ? json.id_token : undefined);
    return {
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
      expiresIn: typeof json.expires_in === 'number' ? json.expires_in : undefined,
      tokenType: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
      scope: typeof json.scope === 'string' ? json.scope : undefined,
      email: identity.email,
      emailVerified: identity.emailVerified,
    };
  }
}

interface EncryptedOAuthStatePayload {
  workspaceId: string;
  mailboxId: string;
  userId: string;
  provider: OutreachOAuthProvider;
  nonce: string;
  exp: number;
}

/**
 * Google Workspace / Microsoft 365 OAuth2 BYO 邮箱托管服务：
 * - start: 生成 AES-256-GCM 加密且带 10 分钟 TTL 与随机 nonce 的 CSRF state；
 * - callback: 验签并解密 state → 换取 OAuth2 令牌 → 核对授权邮箱一致性 → enc:v2 加密入库；
 * - refreshIfNeeded: 发信/IMAP 轮询前自动刷新即将过期的 accessToken 并落回密文。
 */
@Injectable()
export class OutreachOAuthService {
  private readonly httpClient: OutreachOAuthHttpClient;
  private readonly usedNonces = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: PiiCryptoService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(OUTREACH_OAUTH_HTTP_CLIENT) httpClient?: OutreachOAuthHttpClient,
  ) {
    this.httpClient = httpClient ?? new FetchOutreachOAuthHttpClient();
  }

  private assertProvider(raw: string): OutreachOAuthProvider {
    if (raw === 'google' || raw === 'm365') return raw;
    throw new BadRequestException({
      error: { code: 'VALIDATION_ERROR', message: 'provider 必须是 google 或 m365' },
    });
  }

  private providerConfig(provider: OutreachOAuthProvider): {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    authorizeUrl: string;
    tokenUrl: string;
    scope: string;
  } {
    if (provider === 'google') {
      const clientId = this.config.OUTREACH_OAUTH_GOOGLE_CLIENT_ID;
      const clientSecret = this.config.OUTREACH_OAUTH_GOOGLE_CLIENT_SECRET;
      const redirectUri = this.config.OUTREACH_OAUTH_GOOGLE_REDIRECT_URI;
      if (!clientId || !clientSecret || !redirectUri) {
        throw new ServiceUnavailableException({
          error: {
            code: 'OUTREACH_OAUTH_NOT_CONFIGURED',
            message: 'Google Workspace OAuth2 尚未配置（OUTREACH_OAUTH_GOOGLE_*）',
          },
        });
      }
      return {
        clientId,
        clientSecret,
        redirectUri,
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scope: GOOGLE_SCOPES,
      };
    }

    const clientId = this.config.OUTREACH_OAUTH_M365_CLIENT_ID;
    const clientSecret = this.config.OUTREACH_OAUTH_M365_CLIENT_SECRET;
    const redirectUri = this.config.OUTREACH_OAUTH_M365_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
      throw new ServiceUnavailableException({
        error: {
          code: 'OUTREACH_OAUTH_NOT_CONFIGURED',
          message: 'Microsoft 365 OAuth2 尚未配置（OUTREACH_OAUTH_M365_*）',
        },
      });
    }
    const tenant = encodeURIComponent(this.config.OUTREACH_OAUTH_M365_TENANT || 'common');
    return {
      clientId,
      clientSecret,
      redirectUri,
      authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      scope: M365_SCOPES,
    };
  }

  async startAuthorization(
    tenant: OutreachTenant,
    mailboxId: string,
    rawProvider: string,
  ): Promise<{ authorizeUrl: string; provider: OutreachOAuthProvider; stateExpiresAt: string }> {
    const provider = this.assertProvider(rawProvider);
    if (!UUID_RE.test(mailboxId)) {
      throw new NotFoundException({
        error: { code: 'OUTREACH_MAILBOX_NOT_FOUND', message: '发件信箱不存在' },
      });
    }
    // 强制校验密钥环（state 加密 + callback 凭据落库都依赖密钥环）
    this.crypto.requireKeyring();
    const cfg = this.providerConfig(provider);

    const mailbox = await this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
      tx.outreachMailbox.findFirst({
        where: { id: mailboxId, workspaceId: tenant.workspaceId },
        select: { id: true, address: true },
      }),
    );
    if (!mailbox) {
      throw new NotFoundException({
        error: { code: 'OUTREACH_MAILBOX_NOT_FOUND', message: '发件信箱不存在' },
      });
    }

    const exp = Date.now() + OAUTH_STATE_TTL_MS;
    const statePayload: EncryptedOAuthStatePayload = {
      workspaceId: tenant.workspaceId,
      mailboxId: mailbox.id,
      userId: tenant.userId,
      provider,
      nonce: randomBytes(16).toString('base64url'),
      exp,
    };
    const { ciphertext } = this.crypto.encryptSecret(
      OAUTH_STATE_GLOBAL_SCOPE,
      JSON.stringify(statePayload),
      `${OUTREACH_PII_PURPOSE.OAUTH_STATE}:${provider}`,
    );
    const stateToken = Buffer.from(ciphertext, 'utf8').toString('base64url');

    const url = new URL(cfg.authorizeUrl);
    url.searchParams.set('client_id', cfg.clientId);
    url.searchParams.set('redirect_uri', cfg.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', cfg.scope);
    url.searchParams.set('state', stateToken);
    url.searchParams.set('login_hint', mailbox.address);
    if (provider === 'google') {
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('prompt', 'consent');
    } else {
      url.searchParams.set('response_mode', 'query');
    }

    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      workspaceId: tenant.workspaceId,
      action: 'outreach.mailbox.oauth_started',
      target: mailbox.id,
      detail: { provider },
    });

    return {
      authorizeUrl: url.toString(),
      provider,
      stateExpiresAt: new Date(exp).toISOString(),
    };
  }

  async handleCallback(
    tenant: OutreachTenant,
    rawProvider: string,
    query: { code?: string; state?: string; error?: string },
  ): Promise<{ mailbox: SanitizedMailboxView; provider: OutreachOAuthProvider }> {
    const provider = this.assertProvider(rawProvider);
    if (query.error) {
      throw new BadRequestException({
        error: { code: 'OUTREACH_OAUTH_DENIED', message: `OAuth 授权被拒绝：${query.error}` },
      });
    }
    const code = query.code?.trim();
    const state = query.state?.trim();
    if (!code || !state) {
      throw new BadRequestException({
        error: { code: 'OUTREACH_OAUTH_STATE_INVALID', message: '缺少 OAuth code 或 state 参数' },
      });
    }

    let statePayload: EncryptedOAuthStatePayload;
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(state)) {
        throw new Error('non-base64url state');
      }
      const stateBuf = Buffer.from(state, 'base64url');
      if (stateBuf.toString('base64url') !== state) {
        throw new Error('non-canonical base64url state');
      }
      const ciphertext = stateBuf.toString('utf8');
      const rawJson = this.crypto.decryptSecret(
        OAUTH_STATE_GLOBAL_SCOPE,
        ciphertext,
        `${OUTREACH_PII_PURPOSE.OAUTH_STATE}:${provider}`,
      );
      statePayload = JSON.parse(rawJson) as EncryptedOAuthStatePayload;
    } catch {
      throw new BadRequestException({
        error: { code: 'OUTREACH_OAUTH_STATE_INVALID', message: 'OAuth state 校验失败（防 CSRF）' },
      });
    }

    if (
      statePayload.provider !== provider ||
      !UUID_RE.test(statePayload.workspaceId) ||
      !UUID_RE.test(statePayload.mailboxId) ||
      typeof statePayload.nonce !== 'string' ||
      !statePayload.nonce ||
      typeof statePayload.exp !== 'number' ||
      statePayload.exp <= Date.now()
    ) {
      throw new BadRequestException({
        error: { code: 'OUTREACH_OAUTH_STATE_EXPIRED', message: 'OAuth 授权链接已过期，请重新发起' },
      });
    }

    // 强绑定发起授权的管理员会话（防 Login-CSRF 与跨租户/跨用户回调劫持）
    if (
      tenant.workspaceId !== statePayload.workspaceId ||
      tenant.userId !== statePayload.userId
    ) {
      throw new ForbiddenException({
        error: {
          code: 'OUTREACH_OAUTH_SESSION_MISMATCH',
          message: '当前登录会话与发起 OAuth 授权的管理员或工作空间不一致，已拒绝绑定',
        },
      });
    }

    const nowMs = Date.now();
    for (const [n, expMs] of this.usedNonces) {
      if (expMs <= nowMs) this.usedNonces.delete(n);
    }
    if (this.usedNonces.has(statePayload.nonce)) {
      throw new BadRequestException({
        error: { code: 'OUTREACH_OAUTH_STATE_REPLAYED', message: 'OAuth state 已被使用，请重新发起授权' },
      });
    }
    // 按插入顺序淘汰最旧条目，绝不一次性清空仍在有效期内的全部 nonce
    while (this.usedNonces.size >= 10_000) {
      const oldest = this.usedNonces.keys().next().value;
      if (oldest === undefined) break;
      this.usedNonces.delete(oldest);
    }
    this.usedNonces.set(statePayload.nonce, statePayload.exp);

    const cfg = this.providerConfig(provider);
    const tokens = await this.httpClient.exchangeCode({
      provider,
      tokenUrl: cfg.tokenUrl,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      redirectUri: cfg.redirectUri,
      code,
    });

    // fail-closed：必须从 id_token 解析出已验证邮箱（不可在缺失 email claim 或 email_verified=false 时静默放行）
    const verifiedEmail =
      tokens.email && tokens.emailVerified !== false ? tokens.email.trim().toLowerCase() : null;
    if (!verifiedEmail) {
      throw new BadRequestException({
        error: {
          code: 'OUTREACH_OAUTH_EMAIL_UNVERIFIED',
          message: 'OAuth 令牌缺少已验证的邮箱声明，拒绝绑定发件信箱',
        },
      });
    }

    const defaults = PROVIDER_MAIL_DEFAULTS[provider];
    const now = new Date();
    const expiresAt = tokens.expiresIn
      ? new Date(now.getTime() + tokens.expiresIn * 1000)
      : new Date(now.getTime() + 3600_000);

    const updated = await this.prisma.withWorkspace(statePayload.workspaceId, async (tx) => {
      const mailbox = await tx.outreachMailbox.findFirst({
        where: { id: statePayload.mailboxId, workspaceId: statePayload.workspaceId },
      });
      if (!mailbox) {
        throw new NotFoundException({
          error: { code: 'OUTREACH_MAILBOX_NOT_FOUND', message: '发件信箱不存在' },
        });
      }
      if (verifiedEmail !== mailbox.address.toLowerCase()) {
        throw new BadRequestException({
          error: {
            code: 'OUTREACH_OAUTH_EMAIL_MISMATCH',
            message: '授权账号邮箱与所选发件信箱地址不一致，已拒绝绑定',
          },
        });
      }
      const bundle: StoredMailboxCredentials = {
        authMode: defaults.authMode,
        username: mailbox.address,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenType: tokens.tokenType ?? 'Bearer',
        scope: tokens.scope,
        expiresAt: expiresAt.toISOString(),
      };
      const { ciphertext, keyId } = this.crypto.encryptSecret(
        statePayload.workspaceId,
        JSON.stringify(bundle),
        OUTREACH_PII_PURPOSE.MAILBOX_CREDENTIALS,
      );
      return tx.outreachMailbox.update({
        where: { id: mailbox.id },
        data: {
          authMode: defaults.authMode,
          provider: defaults.provider,
          smtpHost: defaults.smtpHost,
          smtpPort: defaults.smtpPort,
          smtpSecure: defaults.smtpSecure,
          imapHost: defaults.imapHost,
          imapPort: defaults.imapPort,
          imapSecure: defaults.imapSecure,
          credentialsCiphertext: ciphertext,
          credentialsKeyId: keyId,
          credentialsUpdatedAt: now,
          oauthTokenExpiresAt: expiresAt,
        },
      });
    });

    await this.audit.record({
      realm: 'tenant',
      actorId: statePayload.userId,
      workspaceId: statePayload.workspaceId,
      action: 'outreach.mailbox.oauth_connected',
      target: updated.id,
      detail: { provider, authMode: defaults.authMode, expiresAt: expiresAt.toISOString() },
    });

    return { mailbox: sanitizeMailboxRow(updated), provider };
  }

  /** 发信或 IMAP 轮询前检查 OAuth2 accessToken 是否临近过期，若存在 refreshToken 则静默刷新并重新加密落库。 */
  async refreshOAuthCredentialsIfNeeded(
    workspaceId: string,
    mailboxId: string,
    bundle: StoredMailboxCredentials,
    now: Date = new Date(),
  ): Promise<StoredMailboxCredentials> {
    if (bundle.authMode !== 'oauth_google' && bundle.authMode !== 'oauth_m365') {
      return bundle;
    }
    const expiresAtMs = bundle.expiresAt ? Date.parse(bundle.expiresAt) : NaN;
    const needsRefresh =
      !bundle.accessToken ||
      (Number.isFinite(expiresAtMs) && expiresAtMs <= now.getTime() + 120_000);
    if (!needsRefresh || !bundle.refreshToken) {
      return bundle;
    }
    const provider: OutreachOAuthProvider = bundle.authMode === 'oauth_google' ? 'google' : 'm365';
    const cfg = this.providerConfig(provider);
    const refreshed = await this.httpClient.refreshToken({
      provider,
      tokenUrl: cfg.tokenUrl,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      refreshToken: bundle.refreshToken,
    });
    const nextExpiresAt = new Date(
      now.getTime() + (refreshed.expiresIn ?? 3600) * 1000,
    );
    const nextBundle: StoredMailboxCredentials = {
      ...bundle,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? bundle.refreshToken,
      tokenType: refreshed.tokenType ?? bundle.tokenType ?? 'Bearer',
      scope: refreshed.scope ?? bundle.scope,
      expiresAt: nextExpiresAt.toISOString(),
    };
    const { ciphertext, keyId } = this.crypto.encryptSecret(
      workspaceId,
      JSON.stringify(nextBundle),
      OUTREACH_PII_PURPOSE.MAILBOX_CREDENTIALS,
    );
    await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.outreachMailbox.update({
        where: { id: mailboxId },
        data: {
          credentialsCiphertext: ciphertext,
          credentialsKeyId: keyId,
          credentialsUpdatedAt: now,
          oauthTokenExpiresAt: nextExpiresAt,
        },
      }),
    );
    return nextBundle;
  }
}

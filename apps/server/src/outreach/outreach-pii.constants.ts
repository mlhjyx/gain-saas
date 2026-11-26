/**
 * gain_saas 外联模块 PII 字段加密用途常量（绑定至 AES-256-GCM AAD: pii:v2:ws:<wsId>:<purpose>）。
 * 所有读写服务与回填脚本必须共用同一常量，防止跨列密文混用。
 */
export const OUTREACH_PII_PURPOSE = {
  DRAFT_RECIPIENT_EMAIL: 'outreach_draft.recipient_email',
  SEND_RECIPIENT_EMAIL: 'outreach_send.recipient_email',
  REPLY_RECIPIENT_EMAIL: 'outreach_reply.recipient_email',
  UNSUBSCRIBE_RECIPIENT_EMAIL: 'outreach_unsubscribe_token.recipient_email',
  CALL_BASIS_PHONE_E164: 'outreach_call_basis.phone_e164',
  CALL_ATTEMPT_NOTES_REF: 'outreach_call_attempt.notes_ref',
  MAILBOX_CREDENTIALS: 'outreach_mailbox.credentials',
  OAUTH_STATE: 'outreach_oauth.state',
} as const;

export const MAILBOX_AUTH_MODES = ['password', 'oauth_google', 'oauth_m365'] as const;
export type MailboxAuthMode = (typeof MAILBOX_AUTH_MODES)[number];

/** 密文信封内的租户 BYO 邮箱凭据包（落库前统一 AES-256-GCM 加密，绝不明文落库或回显）。 */
export interface StoredMailboxCredentials {
  readonly authMode: MailboxAuthMode;
  readonly username: string;
  readonly password?: string;
  readonly imapUsername?: string;
  readonly imapPassword?: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly tokenType?: string;
  readonly scope?: string;
  readonly expiresAt?: string;
}

export interface SanitizedMailboxView {
  readonly id: string;
  readonly workspaceId: string;
  readonly domainId: string;
  readonly address: string;
  readonly displayName: string;
  readonly provider: string;
  readonly authMode: string;
  readonly smtpHost: string | null;
  readonly smtpPort: number | null;
  readonly smtpSecure: boolean;
  readonly imapHost: string | null;
  readonly imapPort: number | null;
  readonly imapSecure: boolean;
  readonly imapMailbox: string;
  readonly hasCredentials: boolean;
  readonly credentialsKeyId: string | null;
  readonly credentialsUpdatedAt: Date | null;
  readonly oauthConnected: boolean;
  readonly oauthTokenExpiresAt: Date | null;
  readonly lastVerifiedAt: Date | null;
  readonly lastVerifyStatus: string | null;
  readonly lastVerifyError: string | null;
  readonly dailyCap: number;
  readonly weeklyCap: number;
  readonly warmupStage: string;
  readonly state: string;
  readonly timezone: string;
  readonly healthState: string;
  readonly lastSendAt: Date | null;
  readonly createdAt: Date;
}

/** 强制剥离 credentialsCiphertext，确保任何租户/运营 API 响应均不可能回显密文或明文凭据。 */
export function sanitizeMailboxRow(row: {
  id: string;
  workspaceId: string;
  domainId: string;
  address: string;
  displayName: string;
  provider: string;
  authMode?: string;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpSecure?: boolean;
  imapHost?: string | null;
  imapPort?: number | null;
  imapSecure?: boolean;
  imapMailbox?: string;
  credentialsCiphertext?: string | null;
  credentialsKeyId?: string | null;
  credentialsUpdatedAt?: Date | null;
  oauthTokenExpiresAt?: Date | null;
  lastVerifiedAt?: Date | null;
  lastVerifyStatus?: string | null;
  lastVerifyError?: string | null;
  dailyCap: number;
  weeklyCap: number;
  warmupStage: string;
  state: string;
  timezone: string;
  healthState: string;
  lastSendAt: Date | null;
  createdAt: Date;
}): SanitizedMailboxView {
  const hasCredentials = Boolean(row.credentialsCiphertext);
  const authMode = row.authMode ?? 'password';
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    domainId: row.domainId,
    address: row.address,
    displayName: row.displayName,
    provider: row.provider,
    authMode,
    smtpHost: row.smtpHost ?? null,
    smtpPort: row.smtpPort ?? null,
    smtpSecure: row.smtpSecure ?? false,
    imapHost: row.imapHost ?? null,
    imapPort: row.imapPort ?? null,
    imapSecure: row.imapSecure ?? true,
    imapMailbox: row.imapMailbox ?? 'INBOX',
    hasCredentials,
    credentialsKeyId: row.credentialsKeyId ?? null,
    credentialsUpdatedAt: row.credentialsUpdatedAt ?? null,
    oauthConnected: hasCredentials && (authMode === 'oauth_google' || authMode === 'oauth_m365'),
    oauthTokenExpiresAt: row.oauthTokenExpiresAt ?? null,
    lastVerifiedAt: row.lastVerifiedAt ?? null,
    lastVerifyStatus: row.lastVerifyStatus ?? null,
    lastVerifyError: row.lastVerifyError ?? null,
    dailyCap: row.dailyCap,
    weeklyCap: row.weeklyCap,
    warmupStage: row.warmupStage,
    state: row.state,
    timezone: row.timezone,
    healthState: row.healthState,
    lastSendAt: row.lastSendAt,
    createdAt: row.createdAt,
  };
}

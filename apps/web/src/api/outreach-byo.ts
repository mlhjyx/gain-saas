import { requestClient } from './request';

export type MailboxAuthMode = 'oauth_google' | 'oauth_m365' | 'password';

export interface ByoMailboxView {
  address: string;
  authMode: MailboxAuthMode;
  createdAt: string;
  credentialsKeyId: string | null;
  credentialsUpdatedAt: string | null;
  dailyCap: number;
  displayName: string;
  domainId: string;
  hasCredentials: boolean;
  healthState: string;
  id: string;
  imapHost: string | null;
  imapMailbox: string;
  imapPort: number | null;
  imapSecure: boolean;
  lastSendAt: string | null;
  lastVerifiedAt: string | null;
  lastVerifyError: string | null;
  lastVerifyStatus: string | null;
  oauthConnected: boolean;
  oauthTokenExpiresAt: string | null;
  provider: string;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  state: 'ACTIVE' | 'PAUSED' | 'RETIRED';
  timezone: string;
  warmupStage: 'MATURE' | 'W1' | 'W2' | 'W3';
  weeklyCap: number;
  workspaceId: string;
}

export interface CreateByoMailboxPayload {
  address: string;
  dailyCap?: number;
  displayName: string;
  provider?: string;
  warmupStage?: 'MATURE' | 'W1' | 'W2' | 'W3';
  weeklyCap?: number;
}

export interface ConfigureByoCredentialsPayload {
  authMode?: MailboxAuthMode;
  imapHost?: string | null;
  imapMailbox?: string;
  imapPassword?: string;
  imapPort?: number | null;
  imapSecure?: boolean;
  imapUsername?: string;
  password?: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure?: boolean;
  username?: string;
}

export interface MailboxConnectionTestResult {
  imap: { error?: string; latencyMs?: number; ok: boolean; skipped?: boolean };
  mailboxId: string;
  ready: boolean;
  smtp: { error?: string; latencyMs?: number; ok: boolean };
  verifiedAt: string;
}

export interface OAuthStartResult {
  authorizeUrl: string;
  provider: 'google' | 'm365';
  stateExpiresAt: string;
}

export interface SenderDomainReport {
  dkim: { present: boolean; selector: string };
  dmarc: {
    hasRua: boolean;
    pct: number | null;
    policy: string | null;
    present: boolean;
    record: string | null;
  };
  domain: string;
  mx: Array<{ exchange: string; priority: number }>;
  ok: { dkim: boolean; dmarc: boolean; mx: boolean; spf: boolean };
  ready: boolean;
  spf: { present: boolean; qualifier: string | null; record: string | null };
}

export interface SenderDomainView {
  createdAt: string;
  dkimSelector: string | null;
  dnsReady: boolean;
  dnsReport: SenderDomainReport | null;
  dnsVerifiedAt: string | null;
  domain: string;
  id: string;
  kind: string;
  state: string;
  workspaceId: string;
}

export interface VerifyDomainDnsResult {
  advice: {
    items?: Array<{ code?: string; message?: string; severity?: string }>;
    level?: string;
    summary?: string;
  };
  domain: SenderDomainView;
  report: SenderDomainReport;
  template: string;
}

export interface BatchPreflightResult {
  batchId: string;
  drafts: Array<{
    allowed: boolean;
    contactRef: string;
    countryCode: string | null;
    draftId: string;
    footerLinesCount: number;
    jurisdictionPolicy: string;
    skipCode?: string;
    skipMessage?: string;
  }>;
  enterpriseApprovalRequired: boolean;
  health: { error?: string; ok: boolean };
  mailbox: {
    address: string | null;
    authMode: string | null;
    error?: string;
    ready: boolean;
    source: 'byo' | 'env' | 'none';
  };
  quickConfirmAllowed: boolean;
  readyCount: number;
  sendEnabled: boolean;
  shadowMode: boolean;
  skippedCount: number;
  status: string;
  totalDrafts: number;
}

export interface BatchQuickConfirmResult {
  confirmation: {
    approvalId: string;
    authorizationId: string | null;
    batchId: string;
    contentHash: string;
    status: string;
  };
  preflight: BatchPreflightResult;
  sendResult?: {
    batchId: string;
    deferred: number;
    failed: number;
    sent: number;
    shadowed: number;
    skipped: number;
    status: string;
  };
}

export const outreachByoApi = {
  listMailboxes: () => requestClient.get<ByoMailboxView[]>('/outreach/mailboxes'),
  createMailbox: (payload: CreateByoMailboxPayload) =>
    requestClient.post<ByoMailboxView>('/outreach/mailboxes', payload),
  deleteMailbox: (mailboxId: string) =>
    requestClient.delete<{ deleted: true; id: string }>(`/outreach/mailboxes/${mailboxId}`),
  configureCredentials: (mailboxId: string, payload: ConfigureByoCredentialsPayload) =>
    requestClient.post<ByoMailboxView>(`/outreach/mailboxes/${mailboxId}/credentials`, payload),
  testConnection: (mailboxId: string) =>
    requestClient.post<MailboxConnectionTestResult>(
      `/outreach/mailboxes/${mailboxId}/test-connection`,
      {},
    ),
  startOAuth: (mailboxId: string, provider: 'google' | 'm365') =>
    requestClient.post<OAuthStartResult>(
      `/outreach/mailboxes/${mailboxId}/oauth/${provider}/start`,
      {},
    ),
  listDomains: () => requestClient.get<SenderDomainView[]>('/outreach/domains'),
  verifyDomainDns: (domainId: string, dkimSelector?: string) =>
    requestClient.post<VerifyDomainDnsResult>(`/outreach/domains/${domainId}/verify-dns`, {
      ...(dkimSelector ? { dkimSelector } : {}),
    }),
  preflightBatch: (batchId: string) =>
    requestClient.post<BatchPreflightResult>(`/outreach/batches/${batchId}/preflight`, {}),
  quickConfirmBatch: (batchId: string, payload: { mailboxId?: string; sendNow?: boolean } = {}) =>
    requestClient.post<BatchQuickConfirmResult>(
      `/outreach/batches/${batchId}/quick-confirm`,
      payload,
    ),
};

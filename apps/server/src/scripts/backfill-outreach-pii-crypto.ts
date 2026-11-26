import { loadConfig } from '../config/configuration.js';
import {
  encryptPii,
  extractPiiKeyId,
  isEncryptedPii,
  parsePiiKeyring,
  type PiiKeyring,
} from '../shared/pii-crypto.js';
import { PiiCryptoService } from '../shared/pii-crypto.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import { OUTREACH_PII_PURPOSE } from '../outreach/outreach-pii.constants.js';

export interface BackfillTableStats {
  table: string;
  scanned: number;
  encrypted: number;
  rotated: number;
  skipped: number;
}

export interface BackfillOutreachPiiOptions {
  /** false（默认）= dry-run 仅统计不写库；true = 实际更新密文 */
  apply: boolean;
  /** true = 除回填明文外，还将非当前 activeKeyId 的密文重加密到最新密钥版本 */
  rotate: boolean;
  /** 可选仅处理单个 workspaceId */
  workspaceId?: string;
}

export interface BackfillOutreachPiiSummary {
  mode: 'dry-run' | 'apply';
  rotate: boolean;
  activeKeyId: string;
  workspacesProcessed: number;
  tables: BackfillTableStats[];
}

function shouldRewrite(stored: string | null | undefined, keyring: PiiKeyring, rotate: boolean): {
  action: 'skip' | 'encrypt' | 'rotate';
} {
  if (!stored) return { action: 'skip' };
  if (!isEncryptedPii(stored)) return { action: 'encrypt' };
  if (rotate) {
    const keyId = extractPiiKeyId(stored);
    if (keyId && keyId !== keyring.activeKeyId) {
      return { action: 'rotate' };
    }
  }
  return { action: 'skip' };
}

/**
 * 外联 6 表 PII enc:v2 安全回填与零停机密钥轮换（幂等、可重跑、绝不打印任何明文邮箱/电话）。
 * 覆盖表与列：
 * - outreach_draft.recipient_email
 * - outreach_send.recipient_email
 * - outreach_reply.recipient_email
 * - outreach_unsubscribe_token.recipient_email
 * - outreach_call_basis.phone_e164
 * - outreach_call_attempt.notes_ref
 */
export async function backfillOutreachPiiCrypto(
  prisma: PrismaService,
  crypto: PiiCryptoService,
  options: BackfillOutreachPiiOptions,
): Promise<BackfillOutreachPiiSummary> {
  const keyring = crypto.requireKeyring();
  const workspaces = options.workspaceId
    ? [{ id: options.workspaceId }]
    : await prisma.workspace.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } });

  const statsMap = new Map<string, BackfillTableStats>([
    ['outreach_draft', { table: 'outreach_draft', scanned: 0, encrypted: 0, rotated: 0, skipped: 0 }],
    ['outreach_send', { table: 'outreach_send', scanned: 0, encrypted: 0, rotated: 0, skipped: 0 }],
    ['outreach_reply', { table: 'outreach_reply', scanned: 0, encrypted: 0, rotated: 0, skipped: 0 }],
    [
      'outreach_unsubscribe_token',
      { table: 'outreach_unsubscribe_token', scanned: 0, encrypted: 0, rotated: 0, skipped: 0 },
    ],
    [
      'outreach_call_basis',
      { table: 'outreach_call_basis', scanned: 0, encrypted: 0, rotated: 0, skipped: 0 },
    ],
    [
      'outreach_call_attempt',
      { table: 'outreach_call_attempt', scanned: 0, encrypted: 0, rotated: 0, skipped: 0 },
    ],
  ]);

  const record = (table: string, action: 'skip' | 'encrypt' | 'rotate') => {
    const s = statsMap.get(table)!;
    s.scanned += 1;
    if (action === 'encrypt') s.encrypted += 1;
    else if (action === 'rotate') s.rotated += 1;
    else s.skipped += 1;
  };

  for (const ws of workspaces) {
    await prisma.withWorkspace(ws.id, async (tx) => {
      // 1. outreach_draft.recipient_email
      const drafts = await tx.outreachDraft.findMany({
        where: { workspaceId: ws.id },
        select: { id: true, recipientEmail: true },
      });
      for (const row of drafts) {
        const decision = shouldRewrite(row.recipientEmail, keyring, options.rotate);
        record('outreach_draft', decision.action);
        if (decision.action === 'skip' || !options.apply) continue;
        const plain = crypto.decryptField(
          ws.id,
          row.recipientEmail,
          OUTREACH_PII_PURPOSE.DRAFT_RECIPIENT_EMAIL,
        );
        const next = encryptPii(
          keyring,
          ws.id,
          plain,
          OUTREACH_PII_PURPOSE.DRAFT_RECIPIENT_EMAIL,
        );
        await tx.outreachDraft.update({
          where: { id: row.id },
          data: { recipientEmail: next },
        });
      }

      // 2. outreach_send.recipient_email
      const sends = await tx.outreachSend.findMany({
        where: { workspaceId: ws.id },
        select: { id: true, recipientEmail: true },
      });
      for (const row of sends) {
        const decision = shouldRewrite(row.recipientEmail, keyring, options.rotate);
        record('outreach_send', decision.action);
        if (decision.action === 'skip' || !options.apply) continue;
        const plain = crypto.decryptField(
          ws.id,
          row.recipientEmail,
          OUTREACH_PII_PURPOSE.SEND_RECIPIENT_EMAIL,
        );
        const next = encryptPii(
          keyring,
          ws.id,
          plain,
          OUTREACH_PII_PURPOSE.SEND_RECIPIENT_EMAIL,
        );
        await tx.outreachSend.update({
          where: { id: row.id },
          data: { recipientEmail: next },
        });
      }

      // 3. outreach_reply.recipient_email
      const replies = await tx.outreachReply.findMany({
        where: { workspaceId: ws.id },
        select: { id: true, recipientEmail: true },
      });
      for (const row of replies) {
        const decision = shouldRewrite(row.recipientEmail, keyring, options.rotate);
        record('outreach_reply', decision.action);
        if (decision.action === 'skip' || !options.apply || !row.recipientEmail) continue;
        const plain = crypto.decryptField(
          ws.id,
          row.recipientEmail,
          OUTREACH_PII_PURPOSE.REPLY_RECIPIENT_EMAIL,
        );
        const next = encryptPii(
          keyring,
          ws.id,
          plain,
          OUTREACH_PII_PURPOSE.REPLY_RECIPIENT_EMAIL,
        );
        await tx.outreachReply.update({
          where: { id: row.id },
          data: { recipientEmail: next },
        });
      }

      // 4. outreach_unsubscribe_token.recipient_email
      const tokens = await tx.outreachUnsubscribeToken.findMany({
        where: { workspaceId: ws.id },
        select: { id: true, recipientEmail: true },
      });
      for (const row of tokens) {
        const decision = shouldRewrite(row.recipientEmail, keyring, options.rotate);
        record('outreach_unsubscribe_token', decision.action);
        if (decision.action === 'skip' || !options.apply || !row.recipientEmail) continue;
        const plain = crypto.decryptField(
          ws.id,
          row.recipientEmail,
          OUTREACH_PII_PURPOSE.UNSUBSCRIBE_RECIPIENT_EMAIL,
        );
        const next = encryptPii(
          keyring,
          ws.id,
          plain,
          OUTREACH_PII_PURPOSE.UNSUBSCRIBE_RECIPIENT_EMAIL,
        );
        await tx.outreachUnsubscribeToken.update({
          where: { id: row.id },
          data: { recipientEmail: next },
        });
      }

      // 5. outreach_call_basis.phone_e164
      const bases = await tx.outreachCallBasis.findMany({
        where: { workspaceId: ws.id },
        select: { id: true, phoneE164: true },
      });
      for (const row of bases) {
        const decision = shouldRewrite(row.phoneE164, keyring, options.rotate);
        record('outreach_call_basis', decision.action);
        if (decision.action === 'skip' || !options.apply) continue;
        const plain = crypto.decryptField(
          ws.id,
          row.phoneE164,
          OUTREACH_PII_PURPOSE.CALL_BASIS_PHONE_E164,
        );
        const next = encryptPii(
          keyring,
          ws.id,
          plain,
          OUTREACH_PII_PURPOSE.CALL_BASIS_PHONE_E164,
        );
        await tx.outreachCallBasis.update({
          where: { id: row.id },
          data: { phoneE164: next },
        });
      }

      // 6. outreach_call_attempt.notes_ref
      const attempts = await tx.outreachCallAttempt.findMany({
        where: { workspaceId: ws.id },
        select: { id: true, notesRef: true },
      });
      for (const row of attempts) {
        const decision = shouldRewrite(row.notesRef, keyring, options.rotate);
        record('outreach_call_attempt', decision.action);
        if (decision.action === 'skip' || !options.apply || !row.notesRef) continue;
        const plain = crypto.decryptField(
          ws.id,
          row.notesRef,
          OUTREACH_PII_PURPOSE.CALL_ATTEMPT_NOTES_REF,
        );
        const next = encryptPii(
          keyring,
          ws.id,
          plain,
          OUTREACH_PII_PURPOSE.CALL_ATTEMPT_NOTES_REF,
        );
        await tx.outreachCallAttempt.update({
          where: { id: row.id },
          data: { notesRef: next },
        });
      }
    });
  }

  return {
    mode: options.apply ? 'apply' : 'dry-run',
    rotate: options.rotate,
    activeKeyId: keyring.activeKeyId,
    workspacesProcessed: workspaces.length,
    tables: [...statsMap.values()],
  };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const rotate = args.includes('--rotate');
  const wsArg = args.find((arg) => arg.startsWith('--workspace-id='));
  const workspaceId = wsArg ? wsArg.slice('--workspace-id='.length).trim() : undefined;

  const config = loadConfig();
  const keyring = parsePiiKeyring(config.PII_KEYRING_JSON, config.PII_ENCRYPTION_KEY);
  if (!keyring) {
    throw new Error('PII_KEYRING_JSON 或 PII_ENCRYPTION_KEY 未配置，无法执行外联 PII 加密回填');
  }

  const prisma = new PrismaService({ enforcePrincipal: false });
  const crypto = new PiiCryptoService(config);
  try {
    const summary = await backfillOutreachPiiCrypto(prisma, crypto, {
      apply,
      rotate,
      workspaceId,
    });
    // 仅输出脱敏聚合计数，绝不打印任何明文邮箱或电话。
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await prisma.onModuleDestroy();
  }
}

const isCli =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1]?.includes('backfill-outreach-pii-crypto');

if (isCli) {
  main().catch((err) => {
    console.error('[backfill-outreach-pii-crypto] failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

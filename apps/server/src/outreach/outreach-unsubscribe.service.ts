import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';

const TOKEN_TTL_MS = 30 * 24 * 3600_000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidToken(): never {
  throw new NotFoundException({
    error: {
      code: 'OUTREACH_UNSUBSCRIBE_TOKEN_INVALID',
      message: '退订链接无效或已过期',
    },
  });
}

/**
 * 一次性退订 token（M2 步 11-1 服务层；公共端点在 11-4 接线）。
 * 只存 SHA-256；无效/过期 404，重复使用幂等成功且不重复写 OPT_OUT。
 */
@Injectable()
export class OutreachUnsubscribeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async issue(tenant: OutreachTenant, contactRef: string, recipientEmail?: string | null) {
    if (!UUID_RE.test(contactRef)) invalidToken();
    const email =
      typeof recipientEmail === 'string' && recipientEmail.includes('@')
        ? recipientEmail.trim().toLowerCase().slice(0, 320)
        : null;
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
    const row = await this.prisma.outreachUnsubscribeToken.create({
      data: {
        workspaceId: tenant.workspaceId,
        contactRef,
        recipientEmail: email,
        tokenHash,
        expiresAt,
      },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.unsubscribe_token.issued',
      target: contactRef,
      detail: { tokenId: row.id, expiresAt: expiresAt.toISOString() },
    });
    return { token, expiresAt, tokenId: row.id };
  }

  async consume(token: unknown): Promise<{
    contactRef: string;
    workspaceId: string;
    recipientEmail: string | null;
    alreadyUsed: boolean;
  }> {
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) {
      invalidToken();
    }
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const row = await this.prisma.outreachUnsubscribeToken.findUnique({
      where: { tokenHash },
    });
    if (!row || row.expiresAt.getTime() <= Date.now()) invalidToken();
    if (row.usedAt) {
      return {
        contactRef: row.contactRef,
        workspaceId: row.workspaceId,
        recipientEmail: row.recipientEmail,
        alreadyUsed: true,
      };
    }
    const used = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.outreachUnsubscribeToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0) return false;
      await tx.outreachConsent.create({
        data: {
          workspaceId: row.workspaceId,
          contactRef: row.contactRef,
          channel: 'email',
          status: 'OPT_OUT',
          source: 'unsubscribe',
          lawfulBasis: 'consent_withdrawal',
          evidence: { tokenId: row.id },
        },
      });
      return true;
    });
    if (!used) {
      return {
        contactRef: row.contactRef,
        workspaceId: row.workspaceId,
        recipientEmail: row.recipientEmail,
        alreadyUsed: true,
      };
    }
    await this.audit.record({
      realm: 'tenant',
      actorId: 'public:unsubscribe',
      action: 'outreach.consent.opted_out',
      target: row.contactRef,
      detail: { tokenId: row.id, source: 'unsubscribe' },
    });
    return {
      contactRef: row.contactRef,
      workspaceId: row.workspaceId,
      recipientEmail: row.recipientEmail,
      alreadyUsed: false,
    };
  }
}

import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../shared/audit.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import { OutreachPublicController } from './outreach-public.controller.js';
import { OutreachReplyService } from './outreach-reply.service.js';

const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONTACT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const tenantA: OutreachTenant = { userId: 'user-a', workspaceId: WS_A, role: 'admin' };

interface Row {
  [key: string]: unknown;
}

class FakeReplyPrisma {
  replies: Row[] = [];
  consents: Row[] = [];
  seq = 0;

  private id(): string {
    return `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`;
  }

  readonly outreachReply = {
    create: async ({ data }: { data: Row }) => {
      const row = {
        id: this.id(),
        receivedAt: new Date(),
        createdAt: new Date(),
        ...data,
      };
      this.replies.push(row);
      return row;
    },
    findMany: async ({ where, take }: { where: Row; take: number }) =>
      this.replies
        .filter((row) => row.workspaceId === where.workspaceId)
        .slice(0, take),
  };

  readonly outreachConsent = {
    create: async ({ data }: { data: Row }) => {
      const row = { id: this.id(), createdAt: new Date(), ...data };
      this.consents.push(row);
      return row;
    },
  };

  readonly $transaction = async <T>(
    fn: (tx: FakeReplyPrisma) => Promise<T>,
  ): Promise<T> => fn(this);
}

function errorCode(error: unknown): string {
  return (error as { response?: { error?: { code?: string } } }).response?.error?.code ?? '';
}

function service(prisma: FakeReplyPrisma) {
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  return new OutreachReplyService(prisma as unknown as PrismaService, audit);
}

describe('OutreachReplyService（M2 步 11-4）', () => {
  it('记录回复并写入 OPT_OUT 同意（回复即停）', async () => {
    const prisma = new FakeReplyPrisma();
    const row = await service(prisma).record(tenantA, {
      contactRef: CONTACT,
      recipientEmail: 'buyer@example.de',
      kind: 'REPLY',
      classification: 'NEGATIVE',
      subject: 'Re: Angebot',
      snippet: 'Kein Interesse',
      externalId: 'msg-1',
    });

    expect(row).toMatchObject({
      workspaceId: WS_A,
      contactRef: CONTACT,
      kind: 'REPLY',
      classification: 'NEGATIVE',
    });
    expect(prisma.consents).toHaveLength(1);
    expect(prisma.consents[0]).toMatchObject({
      workspaceId: WS_A,
      contactRef: CONTACT,
      status: 'OPT_OUT',
      source: 'reply:reply',
      lawfulBasis: 'consent_withdrawal',
    });
  });

  it('退信（BOUNCE）同样写入 OPT_OUT', async () => {
    const prisma = new FakeReplyPrisma();
    await service(prisma).record(tenantA, {
      contactRef: CONTACT,
      kind: 'BOUNCE',
      classification: 'UNKNOWN',
    });
    expect(prisma.consents[0]).toMatchObject({ status: 'OPT_OUT', source: 'reply:bounce' });
  });

  it('负向：非法 kind 被拒绝且不写任何行', async () => {
    const prisma = new FakeReplyPrisma();
    await expect(
      service(prisma).record(tenantA, {
        contactRef: CONTACT,
        kind: 'NOPE' as never,
      }),
    ).rejects.toSatisfy((error) => errorCode(error) === 'VALIDATION_ERROR');
    expect(prisma.replies).toHaveLength(0);
    expect(prisma.consents).toHaveLength(0);
  });

  it('公共退订：消费 token 后同步平台级抑制', async () => {
    const unsubscribe = {
      consume: vi.fn(async () => ({
        contactRef: CONTACT,
        workspaceId: WS_A,
        recipientEmail: 'buyer@example.de',
        alreadyUsed: false,
      })),
    };
    const suppressor = { suppressGlobal: vi.fn(async () => undefined) };
    const controller = new OutreachPublicController(
      unsubscribe as never,
      suppressor as never,
    );
    const json = vi.fn();
    const res = {
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      json,
    };
    const req = {
      query: { token: 'one-click-token' },
      body: { 'List-Unsubscribe': 'One-Click' },
      accepts: () => 'json',
    };

    await controller.consume(req as never, res as never);

    expect(unsubscribe.consume).toHaveBeenCalledWith('one-click-token');
    expect(suppressor.suppressGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS_A }),
      expect.objectContaining({
        email: 'buyer@example.de',
        reason: 'unsubscribe',
        source: 'gain-saas:unsubscribe',
      }),
    );
    expect(json).toHaveBeenCalledWith({
      data: { unsubscribed: true, alreadyUsed: false },
    });
  });

  it('公共退订：GET 不消费 token（防止邮件扫描器误退订）', () => {
    const unsubscribe = { consume: vi.fn() };
    const controller = new OutreachPublicController(
      unsubscribe as never,
      { suppressGlobal: vi.fn() } as never,
    );
    const res = {
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
    controller.confirm('token-123', res as never);
    expect(unsubscribe.consume).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Abmelden'));
  });

  it('列表按 workspace 隔离', async () => {
    const prisma = new FakeReplyPrisma();
    await service(prisma).record(tenantA, { contactRef: CONTACT });
    await service(prisma).record(
      { userId: 'user-b', workspaceId: WS_B, role: 'admin' },
      { contactRef: CONTACT },
    );
    const rows = await service(prisma).list(tenantA);
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBe(WS_A);
  });
});

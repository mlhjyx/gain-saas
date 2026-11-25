import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import { OutreachT0Service } from './outreach-t0.service.js';

const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LEAD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const memberA: OutreachTenant = { userId: 'user-a', workspaceId: WS_A, role: 'member' };
const memberB: OutreachTenant = { userId: 'user-b', workspaceId: WS_B, role: 'member' };

interface Row {
  [key: string]: unknown;
}

class FakeT0Prisma {
  consents: Row[] = [];
  audits: Row[] = [];

  readonly withWorkspace = async (_workspaceId: string, fn: (tx: this) => Promise<unknown>) => fn(this);

  readonly outreachConsent = {
    findFirst: async ({ where }: { where: Row }) =>
      [...this.consents]
        .filter(
          (row) =>
            row.workspaceId === where.workspaceId &&
            row.contactRef === where.contactRef &&
            row.channel === where.channel,
        )
        .at(-1) ?? null,
  };

  readonly auditLog = {
    create: async ({ data }: { data: Row }) => {
      const row = { id: randomUUID(), at: new Date(), ...data };
      this.audits.push(row);
      return row;
    },
    findMany: async ({ where, take }: { where: Row; take: number }) =>
      [...this.audits]
        .reverse()
        .filter((row) => {
          if (
            row.realm !== where.realm ||
            row.action !== where.action ||
            row.target !== where.target ||
            (where.workspaceId !== undefined && row.workspaceId !== where.workspaceId)
          ) {
            return false;
          }
          return true;
        })
        .slice(0, take),
  };
}

describe('OutreachT0Service（T0 四通道合规门禁与轻触达留痕）', () => {
  it('DNC 命中或线索 SUPPRESSED 时禁用全部 4 条触达通道', async () => {
    const prisma = new FakeT0Prisma();
    const dnc = {
      check: vi.fn(async () => new Map([['buyer@refeel.it', ['global:unsubscribe']]])),
    };
    const svc = new OutreachT0Service(prisma as unknown as PrismaService, dnc as never);

    const res = await svc.check(memberA, {
      leadId: LEAD,
      countryCode: 'IT',
      companyName: 'Refeel Solar S.r.l.',
      email: 'buyer@refeel.it',
      phone: '+39 02 123456',
      linkedinUrl: 'https://www.linkedin.com/company/refeel',
      formUrl: 'https://refeel.it/contact',
    });

    expect(res.blockedAll).toBe(true);
    expect(res.blockCode).toBe('SUPPRESSED');
    expect(res.suppressionReasons).toContain('global:unsubscribe');
    expect(res.channels.mailto.allowed).toBe(false);
    expect(res.channels.linkedin.allowed).toBe(false);
    expect(res.channels.whatsapp.allowed).toBe(false);
    expect(res.channels.form.allowed).toBe(false);
  });

  it('DNC 服务不可达时 fail-closed 阻断全部通道', async () => {
    const prisma = new FakeT0Prisma();
    const dnc = { check: vi.fn(async () => { throw new Error('engine down'); }) };
    const svc = new OutreachT0Service(prisma as unknown as PrismaService, dnc as never);

    const res = await svc.check(memberA, {
      leadId: LEAD,
      countryCode: 'IT',
      companyName: 'Refeel Solar S.r.l.',
      email: 'buyer@refeel.it',
    });
    expect(res.blockedAll).toBe(true);
    expect(res.blockCode).toBe('DNC_UNAVAILABLE');
  });

  it('DE 禁用 mailto 并引导领英/表单；BR 放行合规 wa.me', async () => {
    const prisma = new FakeT0Prisma();
    const dnc = { check: vi.fn(async () => new Map()) };
    const svc = new OutreachT0Service(prisma as unknown as PrismaService, dnc as never);

    const de = await svc.check(memberA, {
      leadId: LEAD,
      countryCode: 'DE',
      companyName: 'Solaris GmbH',
      email: 'sales@solaris.de',
      formUrl: 'https://solaris.de/kontakt',
    });
    expect(de.blockedAll).toBe(false);
    expect(de.channels.mailto.allowed).toBe(false);
    expect(de.channels.linkedin.allowed).toBe(true);
    expect(de.channels.form.allowed).toBe(true);

    const br = await svc.check(memberA, {
      leadId: LEAD,
      countryCode: 'BR',
      companyName: 'Sol Brasil Ltda',
      email: 'compras@solbrasil.com.br',
      phone: '+55 11 98765-4321',
    });
    expect(br.channels.mailto.allowed).toBe(true);
    expect(br.channels.whatsapp.allowed).toBe(true);
  });

  it('轻触达留痕：对个人邮箱脱敏落库，并严格按 workspace 隔离读取', async () => {
    const prisma = new FakeT0Prisma();
    const dnc = { check: vi.fn(async () => new Map()) };
    const svc = new OutreachT0Service(prisma as unknown as PrismaService, dnc as never);

    const created = await svc.recordTouch(memberA, {
      leadId: LEAD,
      channel: 'mailto',
      target: 'maria.rossi@refeel.it',
      note: '已用本地邮箱发出首触',
      outcome: 'OPENED',
    });
    expect(created.targetMasked).toBe('m***@refeel.it');
    expect(prisma.audits[0]?.workspaceId).toBe(WS_A);
    expect(JSON.stringify(prisma.audits)).not.toContain('maria.rossi@refeel.it');

    const listA = await svc.listTouches(memberA, LEAD);
    expect(listA).toHaveLength(1);
    expect(listA[0]).toMatchObject({
      leadId: LEAD,
      channel: 'mailto',
      targetMasked: 'm***@refeel.it',
      note: '已用本地邮箱发出首触',
    });

    const listB = await svc.listTouches(memberB, LEAD);
    expect(listB).toHaveLength(0);
  });
});

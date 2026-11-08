import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../shared/prisma.service.js';
import type { AuditService } from '../shared/audit.service.js';
import type { TenantRequestContext } from '../tenant/tenant.guard.js';
import { QgoService, normalizeQgoEvidence } from './qgo.service.js';

const WS = '11111111-1111-4111-8111-111111111111';
const WS_OTHER = '99999999-9999-4999-8999-999999999999';
const USER = '22222222-2222-4222-8222-222222222222';
const LEAD = '33333333-3333-4333-8333-333333333333';
const COMPANY = '44444444-4444-4444-8444-444444444444';
const ICP = '55555555-5555-4555-8555-555555555555';
const QGO_ID = '66666666-6666-4666-8666-666666666666';
const SAO_ID = '77777777-7777-4777-8777-777777777777';

const ctx = (workspaceId = WS): TenantRequestContext =>
  ({
    userId: USER,
    workspaceId,
    role: 'admin',
    jti: 'j',
    exp: 0,
    onboardingCompleted: true,
    onboardingCompanyId: null,
  }) as TenantRequestContext;

const EVIDENCE = [{ type: 'customer_reply', url: 'https://example.test/reply', support: '询价 200 台' }];

function snapshot(over: Record<string, unknown> = {}) {
  return {
    lead_id: LEAD,
    icp_id: ICP,
    company_ref: { canonical_company_id: COMPANY, name: 'Pumpen Handel GmbH' },
    scores: { total: 0.72 },
    ...over,
  };
}

interface QgoRowShape {
  id: string;
  workspaceId: string;
  leadRef: string;
  canonicalCompanyRef: string;
  icpRef: string | null;
  campaignId: string | null;
  title: string;
  score: number | null;
  evidence: unknown;
  nextStep: string;
  state: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

function fixture(options: { qualified?: unknown; existingQgo?: QgoRowShape; sao?: { id: string; state: string } } = {}) {
  const qgos = new Map<string, QgoRowShape>();
  if (options.existingQgo) qgos.set(options.existingQgo.id, options.existingQgo);
  const saoRows = new Map<string, { id: string; workspaceId: string; qgoId: string; state: string; decidedBy: string; decidedAt: Date; reason: string | null }>();
  if (options.sao) {
    saoRows.set(options.sao.id, {
      id: options.sao.id,
      workspaceId: WS,
      qgoId: 'qgo-existing',
      state: options.sao.state,
      decidedBy: USER,
      decidedAt: new Date('2026-11-08T00:00:00Z'),
      reason: null,
    });
  }
  const outcomes: Array<Record<string, unknown>> = [];

  const qgoFindFirst = vi.fn(async (args: { where: { id?: string; workspaceId: string; leadRef?: string }; include?: unknown }) => {
    for (const row of qgos.values()) {
      if (row.workspaceId !== args.where.workspaceId) continue;
      if (args.where.id !== undefined && row.id !== args.where.id) continue;
      if (args.where.leadRef !== undefined && row.leadRef !== args.where.leadRef) continue;
      if (!args.include) return { ...row };
      const sao = [...saoRows.values()].find((s) => s.qgoId === row.id && s.workspaceId === row.workspaceId);
      return {
        ...row,
        sao: sao
          ? { ...sao, outcomes: outcomes.filter((o) => o.saoId === sao.id) }
          : null,
      };
    }
    return null;
  });
  const qgoCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    const row: QgoRowShape = {
      id: `qgo-${qgos.size + 1}`,
      workspaceId: String(data.workspaceId),
      leadRef: String(data.leadRef),
      canonicalCompanyRef: String(data.canonicalCompanyRef),
      icpRef: (data.icpRef as string | undefined) ?? null,
      campaignId: (data.campaignId as string | undefined) ?? null,
      title: String(data.title),
      score: (data.score as number | undefined) ?? null,
      evidence: data.evidence,
      nextStep: String(data.nextStep),
      state: String(data.state),
      createdBy: String(data.createdBy),
      createdAt: new Date('2026-11-08T01:00:00Z'),
      updatedAt: new Date('2026-11-08T01:00:00Z'),
    };
    if ([...qgos.values()].some((q) => q.workspaceId === row.workspaceId && q.leadRef === row.leadRef)) {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });
    }
    qgos.set(row.id, row);
    return row;
  });
  const qgoFindMany = vi.fn(async () => [...qgos.values()]);
  const qgoUpdateMany = vi.fn(async (args: { where: { id: string; workspaceId: string; state: string }; data: { state: string } }) => {
    const row = qgos.get(args.where.id);
    if (!row || row.workspaceId !== args.where.workspaceId || row.state !== args.where.state) return { count: 0 };
    row.state = args.data.state;
    return { count: 1 };
  });

  const tx = {
    qgo: { findFirst: qgoFindFirst, updateMany: qgoUpdateMany },
    sao: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `sao-${saoRows.size + 1}`,
          workspaceId: String(data.workspaceId),
          qgoId: String(data.qgoId),
          state: String(data.state),
          decidedBy: String(data.decidedBy),
          decidedAt: data.decidedAt as Date,
          reason: (data.reason as string | undefined) ?? null,
        };
        saoRows.set(row.id, row);
        return row;
      }),
    },
  };
  const prisma = {
    qgo: { findFirst: qgoFindFirst, create: qgoCreate, findMany: qgoFindMany, updateMany: qgoUpdateMany },
    qualifiedLead: { findFirst: vi.fn(async () => options.qualified ?? null) },
    sao: {
      findFirst: vi.fn(async (args: { where: { id: string; workspaceId: string } }) => {
        const row = saoRows.get(args.where.id);
        if (!row || row.workspaceId !== args.where.workspaceId) return null;
        return { id: row.id, state: row.state };
      }),
    },
    opportunityOutcome: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `outcome-${outcomes.length + 1}`, createdAt: new Date('2026-11-08T02:00:00Z'), ...data };
        outcomes.push(row);
        return row;
      }),
    },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const service = new QgoService(prisma as unknown as PrismaService, audit as unknown as AuditService);
  return { service, prisma, audit, qgos, saoRows, outcomes, qgoCreate };
}

describe('normalizeQgoEvidence（证据门）', () => {
  it('空/缺失 → 400 QGO_EVIDENCE_REQUIRED', () => {
    for (const bad of [undefined, null, [], 'x']) {
      try {
        normalizeQgoEvidence(bad);
        expect.unreachable('应当抛错');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getResponse()).toMatchObject({ error: { code: 'QGO_EVIDENCE_REQUIRED' } });
      }
    }
  });

  it('非法 URL / 协议 / 超界 → VALIDATION_ERROR', () => {
    expect(() => normalizeQgoEvidence([{ type: 'x', url: 'not-a-url' }])).toThrow(BadRequestException);
    expect(() => normalizeQgoEvidence([{ type: 'x', url: 'ftp://example.test/f' }])).toThrow(BadRequestException);
    expect(() => normalizeQgoEvidence([{ type: '' }])).toThrow(BadRequestException);
    expect(() => normalizeQgoEvidence(Array.from({ length: 11 }, () => ({ type: 't' })))).toThrow(BadRequestException);
  });

  it('规范化保留 type/url/retrievedAt/support', () => {
    expect(
      normalizeQgoEvidence([
        { type: ' tender_hit ', url: 'https://example.test/t', retrievedAt: '2026-11-01T00:00:00Z', support: ' 招标公告 ' },
      ]),
    ).toEqual([{ type: 'tender_hit', url: 'https://example.test/t', retrievedAt: '2026-11-01T00:00:00Z', support: '招标公告' }]);
  });
});

describe('QgoService.promote（提升：证据门 + 已接受线索 + 幂等）', () => {
  it('无证据 → 400；未知/跨租户线索 → 409 LEAD_NOT_QUALIFIED（不泄露存在性）', async () => {
    const f = fixture();
    await expect(
      f.service.promote(ctx(), { leadRef: LEAD, evidence: [], nextStep: '发样' }),
    ).rejects.toMatchObject({ response: { error: { code: 'QGO_EVIDENCE_REQUIRED' } } });
    await expect(
      f.service.promote(ctx(), { leadRef: LEAD, evidence: EVIDENCE, nextStep: '发样' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('从 LeadQualified 快照派生公司/ICP/标题/分数并写审计', async () => {
    const f = fixture({ qualified: { leadId: LEAD, snapshot: snapshot() } });
    const result = await f.service.promote(ctx(), { leadRef: LEAD, evidence: EVIDENCE, nextStep: '发样 200 台' });
    expect(result.created).toBe(true);
    expect(result.qgo).toMatchObject({
      leadRef: LEAD,
      canonicalCompanyRef: COMPANY,
      icpRef: ICP,
      title: 'Pumpen Handel GmbH',
      score: 0.72,
      state: 'OPEN',
      nextStep: '发样 200 台',
    });
    expect(f.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'qgo.promote', target: result.qgo.id }),
    );
  });

  it('同 lead 重复提升 → 幂等返回同一 QGO（created=false，不新增）', async () => {
    const f = fixture({ qualified: { leadId: LEAD, snapshot: snapshot() } });
    const first = await f.service.promote(ctx(), { leadRef: LEAD, evidence: EVIDENCE, nextStep: '发样' });
    const second = await f.service.promote(ctx(), { leadRef: LEAD, evidence: EVIDENCE, nextStep: '发样' });
    expect(second.created).toBe(false);
    expect(second.qgo.id).toBe(first.qgo.id);
    expect(f.qgoCreate).toHaveBeenCalledTimes(1);
  });

  it('并发双击（P2002）→ 返回既有 QGO 而不是报错', async () => {
    const existing: QgoRowShape = {
      id: QGO_ID,
      workspaceId: WS,
      leadRef: LEAD,
      canonicalCompanyRef: COMPANY,
      icpRef: ICP,
      campaignId: null,
      title: 'Pumpen Handel GmbH',
      score: 0.72,
      evidence: EVIDENCE,
      nextStep: '发样',
      state: 'OPEN',
      createdBy: USER,
      createdAt: new Date('2026-11-08T01:00:00Z'),
      updatedAt: new Date('2026-11-08T01:00:00Z'),
    };
    const f = fixture({ qualified: { leadId: LEAD, snapshot: snapshot() }, existingQgo: { ...existing } });
    // 先查不到（绕过幂等前置查询），create 时唯一键冲突，随后重查命中。
    let calls = 0;
    (f.prisma.qgo.findFirst as unknown as { mockImplementation: (fn: unknown) => void }).mockImplementation(async (args: { where: { workspaceId: string; leadRef?: string }; include?: unknown }) => {
      calls += 1;
      if (calls === 1) return null; // 前置幂等查询未命中
      return { ...existing } as never; // 冲突后的重查 / detailRow 命中
    });
    const result = await f.service.promote(ctx(), { leadRef: LEAD, evidence: EVIDENCE, nextStep: '发样' });
    expect(result.created).toBe(false);
    expect(result.qgo.id).toBe(QGO_ID);
  });
});

describe('QgoService.accept/decline（SAO 人工裁决）', () => {
  const openQgo: QgoRowShape = {
    id: QGO_ID,
    workspaceId: WS,
    leadRef: LEAD,
    canonicalCompanyRef: COMPANY,
    icpRef: ICP,
    campaignId: null,
    title: 'Pumpen Handel GmbH',
    score: 0.72,
    evidence: EVIDENCE,
    nextStep: '发样',
    state: 'OPEN',
    createdBy: USER,
    createdAt: new Date('2026-11-08T01:00:00Z'),
    updatedAt: new Date('2026-11-08T01:00:00Z'),
  };

  it('接受：OPEN → CONVERTED + SAO(ACCEPTED) 并写审计', async () => {
    const f = fixture({ existingQgo: { ...openQgo } });
    const detail = await f.service.accept(ctx(), QGO_ID);
    expect(detail.state).toBe('CONVERTED');
    expect(detail.sao).toMatchObject({ state: 'ACCEPTED' });
    expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'qgo.accept', target: QGO_ID }));
  });

  it('非 OPEN 再接受 → 409 INVALID_STATE', async () => {
    const f = fixture({ existingQgo: { ...openQgo, state: 'CONVERTED' } });
    await expect(f.service.accept(ctx(), QGO_ID)).rejects.toMatchObject({
      response: { error: { code: 'INVALID_STATE' } },
    });
  });

  it('拒绝必须带理由；随后 QGO → DROPPED + SAO(DECLINED)', async () => {
    const noReason = fixture({ existingQgo: { ...openQgo } });
    await expect(noReason.service.decline(ctx(), QGO_ID, '  ')).rejects.toBeInstanceOf(BadRequestException);

    const f = fixture({ existingQgo: { ...openQgo } });
    const detail = await f.service.decline(ctx(), QGO_ID, '预算冻结');
    expect(detail.state).toBe('DROPPED');
    expect(detail.sao).toMatchObject({ state: 'DECLINED', reason: '预算冻结' });
  });

  it('跨租户（他空间 QGO）→ 404', async () => {
    const f = fixture({ existingQgo: { ...openQgo } });
    await expect(f.service.accept(ctx(WS_OTHER), QGO_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('QgoService.addOutcome（append-only 结果登记）', () => {
  it('枚举外 → 400 INVALID_OUTCOME；DECLINED 的 SAO → 409', async () => {
    const invalid = fixture({ sao: { id: SAO_ID, state: 'ACCEPTED' } });
    await expect(
      invalid.service.addOutcome(ctx(), SAO_ID, { outcome: 'MAYBE' as never }),
    ).rejects.toMatchObject({ response: { error: { code: 'INVALID_OUTCOME' } } });

    const declined = fixture({ sao: { id: SAO_ID, state: 'DECLINED' } });
    await expect(
      declined.service.addOutcome(ctx(), SAO_ID, { outcome: 'REPLIED' }),
    ).rejects.toMatchObject({ response: { error: { code: 'INVALID_STATE' } } });
  });

  it('登记成功：source=MANUAL、可重复（append-only）、写审计', async () => {
    const f = fixture({ sao: { id: SAO_ID, state: 'ACCEPTED' } });
    const first = await f.service.addOutcome(ctx(), SAO_ID, {
      outcome: 'REPLIED',
      occurredAt: '2026-11-08T09:00:00Z',
      note: '客户询价',
    });
    expect(first).toMatchObject({ outcome: 'REPLIED', source: 'MANUAL', occurredAt: '2026-11-08T09:00:00.000Z' });
    await f.service.addOutcome(ctx(), SAO_ID, { outcome: 'MEETING_BOOKED' });
    expect(f.outcomes).toHaveLength(2);
    expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'opportunity.outcome' }));
  });

  it('跨租户 SAO → 404', async () => {
    const f = fixture({ sao: { id: SAO_ID, state: 'ACCEPTED' } });
    await expect(
      f.service.addOutcome(ctx(WS_OTHER), SAO_ID, { outcome: 'REPLIED' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

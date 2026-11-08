import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../shared/prisma.service.js';
import { AuditService } from '../shared/audit.service.js';
import type { TenantRequestContext } from '../tenant/tenant.guard.js';

/**
 * M2 步 10：QGO / SAO / Opportunity Outcome（Growth Core）。
 * 设计 docs/superpowers/plans/2026-11-08-qgo-domain-m2-step10.md（APPROVED）：
 * - 只有已接受（LeadQualified 影子行存在）的线索可以提升为 QGO（D-10-b 证据门：≥1 条证据 + next_step）；
 * - SAO 必须人工接受/拒绝（D-10-c），拒绝需理由；
 * - Outcome v0 闭集 7 枚举（D-10-d），append-only；
 * - 全部 workspace 过滤 + 跨租户 404；人工动作写 audit_log。
 */

export const OUTCOME_VALUES = [
  'REPLIED',
  'MEETING_BOOKED',
  'QUOTE_SENT',
  'WON',
  'LOST',
  'NO_RESPONSE',
  'DISQUALIFIED',
] as const;
export type OutcomeValue = (typeof OUTCOME_VALUES)[number];

export interface QgoEvidenceItem {
  type: string;
  url?: string;
  retrievedAt?: string;
  support?: string;
}

/** 提升入参按 unknown 接收：控制器原样透传请求体，规范化与校验集中在服务层（可测）。 */
export interface PromoteQgoInput {
  leadRef?: unknown;
  evidence?: unknown;
  nextStep?: unknown;
  campaignId?: unknown;
}

export interface OutcomeInput {
  outcome: OutcomeValue;
  occurredAt?: string;
  evidenceRef?: string;
  note?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EVIDENCE = 10;

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

/** 证据条目规范化（结构 + 长度边界；URL 只收 http/https）。空数组 → QGO_EVIDENCE_REQUIRED。 */
export function normalizeQgoEvidence(input: unknown): QgoEvidenceItem[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new BadRequestException({
      error: {
        code: 'QGO_EVIDENCE_REQUIRED',
        message: '提升为商机至少需要一条需求/时机证据（如客户回复、官网采购页、招标命中、海关信号）',
      },
    });
  }
  if (input.length > MAX_EVIDENCE) invalid(`evidence 最多 ${MAX_EVIDENCE} 条`);
  return input.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid(`evidence[${index}] 必须是对象`);
    const item = raw as Record<string, unknown>;
    const type = typeof item.type === 'string' ? item.type.trim() : '';
    if (!type || type.length > 64) invalid(`evidence[${index}].type 必须是 1–64 字符`);
    const url = typeof item.url === 'string' ? item.url.trim() : undefined;
    if (url !== undefined) {
      if (url.length === 0 || url.length > 2048) invalid(`evidence[${index}].url 长度不合法`);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return invalid(`evidence[${index}].url 不是合法 URL`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        invalid(`evidence[${index}].url 只接受 http/https`);
      }
    }
    const retrievedAt = typeof item.retrievedAt === 'string' ? item.retrievedAt.trim() : undefined;
    if (retrievedAt !== undefined && Number.isNaN(Date.parse(retrievedAt))) {
      invalid(`evidence[${index}].retrievedAt 不是合法时间`);
    }
    const support = typeof item.support === 'string' ? item.support.trim() : undefined;
    if (support !== undefined && support.length > 500) invalid(`evidence[${index}].support 最多 500 字符`);
    return {
      type,
      ...(url === undefined ? {} : { url }),
      ...(retrievedAt === undefined ? {} : { retrievedAt }),
      ...(support === undefined || support.length === 0 ? {} : { support }),
    };
  });
}

type QgoRow = Prisma.QgoGetPayload<Record<string, never>>;

function serializeQgo(
  row: QgoRow,
  sao?: { state: string; decidedAt: Date; reason: string | null } | null,
  outcomes?: Array<Record<string, unknown>>,
) {
  return {
    id: row.id,
    leadRef: row.leadRef,
    canonicalCompanyRef: row.canonicalCompanyRef,
    icpRef: row.icpRef,
    campaignId: row.campaignId,
    title: row.title,
    score: row.score,
    evidence: row.evidence,
    nextStep: row.nextStep,
    state: row.state,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    sao: sao
      ? { state: sao.state, decidedAt: sao.decidedAt.toISOString(), reason: sao.reason }
      : null,
    ...(outcomes === undefined ? {} : { outcomes }),
  };
}

@Injectable()
export class QgoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 从已接受的线索（LeadQualified 影子行）提升为 QGO：证据门 + 幂等（workspace, leadRef）。 */
  async promote(ctx: TenantRequestContext, input: PromoteQgoInput) {
    const leadRef = typeof input.leadRef === 'string' ? input.leadRef.trim() : '';
    if (!UUID.test(leadRef)) invalid('leadRef 必须是 UUID');
    const evidence = normalizeQgoEvidence(input.evidence);
    const nextStep = typeof input.nextStep === 'string' ? input.nextStep.trim() : '';
    if (!nextStep || nextStep.length > 500) invalid('nextStep 必须是 1–500 字符');
    const campaignId =
      input.campaignId === undefined || input.campaignId === null ? undefined : String(input.campaignId);
    if (campaignId !== undefined && !UUID.test(campaignId)) invalid('campaignId 必须是 UUID');

    const existing = await this.prisma.qgo.findFirst({
      where: { workspaceId: ctx.workspaceId, leadRef },
    });
    if (existing) {
      // 幂等重放：返回同一 QGO（不覆盖证据/下一步——提升是「一次性」的人类动作）。
      return { qgo: await this.detailRow(ctx, existing.id), created: false as const };
    }

    const qualified = await this.prisma.qualifiedLead.findFirst({
      where: { workspaceId: ctx.workspaceId, leadId: leadRef },
    });
    if (!qualified) {
      throw new ConflictException({
        error: {
          code: 'LEAD_NOT_QUALIFIED',
          message: '只有已接受（LeadQualified）的线索才能提升为商机；请先在「买家线索」里接受该线索',
        },
      });
    }
    const snapshot = qualified.snapshot as {
      company_ref?: { canonical_company_id?: unknown; name?: unknown };
      icp_id?: unknown;
      scores?: { total?: unknown };
    } | null;
    const canonicalCompanyRef = snapshot?.company_ref?.canonical_company_id;
    if (typeof canonicalCompanyRef !== 'string' || !UUID.test(canonicalCompanyRef)) {
      throw new ConflictException({
        error: { code: 'LEAD_NOT_QUALIFIED', message: '线索快照缺少公司引用，无法提升' },
      });
    }
    const title =
      typeof snapshot?.company_ref?.name === 'string' && snapshot.company_ref.name.trim()
        ? snapshot.company_ref.name.trim().slice(0, 200)
        : '未命名商机';
    const score = typeof snapshot?.scores?.total === 'number' ? snapshot.scores.total : null;
    const icpRef = typeof snapshot?.icp_id === 'string' && UUID.test(snapshot.icp_id) ? snapshot.icp_id : null;

    let created: QgoRow;
    try {
      created = await this.prisma.qgo.create({
        data: {
          workspaceId: ctx.workspaceId,
          leadRef,
          canonicalCompanyRef,
          icpRef,
          ...(campaignId === undefined ? {} : { campaignId }),
          title,
          score,
          evidence: evidence as unknown as Prisma.InputJsonValue,
          nextStep,
          state: 'OPEN',
          createdBy: ctx.userId,
        },
      });
    } catch (err) {
      // 并发双击：唯一键兜底 → 返回既有行（幂等语义）。
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const replay = await this.prisma.qgo.findFirst({
          where: { workspaceId: ctx.workspaceId, leadRef },
        });
        if (replay) return { qgo: await this.detailRow(ctx, replay.id), created: false as const };
      }
      throw err;
    }
    await this.audit.record({
      realm: 'tenant',
      actorId: ctx.userId,
      action: 'qgo.promote',
      target: created.id,
      detail: { leadRef, evidenceCount: evidence.length, campaignId: campaignId ?? null },
    });
    return { qgo: serializeQgo(created), created: true as const };
  }

  async list(
    ctx: TenantRequestContext,
    opts: { state?: string; campaignId?: string; limit: number; cursor?: string },
  ) {
    if (opts.state !== undefined && !['OPEN', 'CONVERTED', 'DROPPED'].includes(opts.state)) {
      invalid('state 只接受 OPEN | CONVERTED | DROPPED');
    }
    if (opts.campaignId !== undefined && !UUID.test(opts.campaignId)) invalid('campaignId 必须是 UUID');
    const rows = await this.prisma.qgo.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        ...(opts.state ? { state: opts.state } : {}),
        ...(opts.campaignId ? { campaignId: opts.campaignId } : {}),
      },
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      include: { sao: { select: { state: true, decidedAt: true, reason: true } } },
    });
    const page = rows.slice(0, opts.limit);
    const hasMore = rows.length > opts.limit;
    return {
      data: page.map((row) => serializeQgo(row, row.sao)),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
      hasMore,
    };
  }

  async detail(ctx: TenantRequestContext, id: string) {
    if (!UUID.test(id)) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'qgo not found' } });
    return this.detailRow(ctx, id);
  }

  private async detailRow(ctx: TenantRequestContext, id: string) {
    const row = await this.prisma.qgo.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
      include: {
        sao: {
          include: { outcomes: { orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }] } },
        },
      },
    });
    if (!row) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'qgo not found' } });
    const outcomes = row.sao?.outcomes.map((outcome) => ({
      id: outcome.id,
      outcome: outcome.outcome,
      occurredAt: outcome.occurredAt.toISOString(),
      source: outcome.source,
      evidenceRef: outcome.evidenceRef,
      note: outcome.note,
      createdAt: outcome.createdAt.toISOString(),
    }));
    return serializeQgo(row, row.sao, outcomes);
  }

  /** 人工接受：OPEN → CONVERTED + SAO(ACCEPTED)，同一事务；非 OPEN → 409（D-10-c）。 */
  async accept(ctx: TenantRequestContext, id: string) {
    const result = await this.decide(ctx, id, 'ACCEPTED', undefined);
    await this.audit.record({
      realm: 'tenant',
      actorId: ctx.userId,
      action: 'qgo.accept',
      target: id,
      detail: { saoId: result.saoId },
    });
    return this.detailRow(ctx, id);
  }

  /** 人工拒绝：OPEN → DROPPED + SAO(DECLINED)，理由必填（D-10-c）。 */
  async decline(ctx: TenantRequestContext, id: string, reason: unknown) {
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (!text || text.length > 1000) invalid('拒绝必须填写理由（1–1000 字符）');
    const result = await this.decide(ctx, id, 'DECLINED', text);
    await this.audit.record({
      realm: 'tenant',
      actorId: ctx.userId,
      action: 'qgo.decline',
      target: id,
      detail: { saoId: result.saoId, reason: text },
    });
    return this.detailRow(ctx, id);
  }

  private async decide(
    ctx: TenantRequestContext,
    id: string,
    state: 'ACCEPTED' | 'DECLINED',
    reason: string | undefined,
  ): Promise<{ saoId: string; decidedAt: Date }> {
    if (!UUID.test(id)) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'qgo not found' } });
    const decidedAt = new Date();
    const saoId = await this.prisma.$transaction(async (tx) => {
      const qgo = await tx.qgo.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
      if (!qgo) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'qgo not found' } });
      // CAS：只有 OPEN 能被裁决；否则 409（含并发双击）。
      const cas = await tx.qgo.updateMany({
        where: { id, workspaceId: ctx.workspaceId, state: 'OPEN' },
        data: { state: state === 'ACCEPTED' ? 'CONVERTED' : 'DROPPED' },
      });
      if (cas.count === 0) {
        throw new ConflictException({
          error: { code: 'INVALID_STATE', message: `qgo is ${qgo.state}; only OPEN can be decided` },
        });
      }
      const sao = await tx.sao.create({
        data: {
          workspaceId: ctx.workspaceId,
          qgoId: id,
          state,
          decidedBy: ctx.userId,
          decidedAt,
          ...(reason === undefined ? {} : { reason }),
        },
      });
      return sao.id;
    });
    return { saoId, decidedAt };
  }

  /** Outcome 登记（append-only）：只有 ACCEPTED 的 SAO 可登记；枚举闭集。 */
  async addOutcome(ctx: TenantRequestContext, saoId: string, input: OutcomeInput) {
    if (!UUID.test(saoId)) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'sao not found' } });
    const sao = await this.prisma.sao.findFirst({
      where: { id: saoId, workspaceId: ctx.workspaceId },
      select: { id: true, state: true },
    });
    if (!sao) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'sao not found' } });
    if (sao.state !== 'ACCEPTED') {
      throw new ConflictException({
        error: { code: 'INVALID_STATE', message: '只有已接受（ACCEPTED）的商机可以登记结果' },
      });
    }
    const outcome = String(input.outcome ?? '');
    if (!(OUTCOME_VALUES as readonly string[]).includes(outcome)) {
      throw new BadRequestException({
        error: {
          code: 'INVALID_OUTCOME',
          message: `outcome 只接受 ${OUTCOME_VALUES.join(' | ')}`,
        },
      });
    }
    let occurredAt = new Date();
    if (input.occurredAt !== undefined) {
      const parsed = Date.parse(input.occurredAt);
      if (Number.isNaN(parsed)) invalid('occurredAt 不是合法时间');
      occurredAt = new Date(parsed);
    }
    const note = typeof input.note === 'string' ? input.note.trim() : undefined;
    if (note !== undefined && note.length > 2000) invalid('note 最多 2000 字符');
    const evidenceRef = typeof input.evidenceRef === 'string' ? input.evidenceRef.trim() : undefined;
    if (evidenceRef !== undefined && evidenceRef.length > 2048) invalid('evidenceRef 最多 2048 字符');

    const created = await this.prisma.opportunityOutcome.create({
      data: {
        workspaceId: ctx.workspaceId,
        saoId,
        outcome,
        occurredAt,
        source: 'MANUAL',
        ...(evidenceRef === undefined || evidenceRef.length === 0 ? {} : { evidenceRef }),
        ...(note === undefined || note.length === 0 ? {} : { note }),
        createdBy: ctx.userId,
      },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: ctx.userId,
      action: 'opportunity.outcome',
      target: saoId,
      detail: { outcome, occurredAt: occurredAt.toISOString() },
    });
    return {
      id: created.id,
      saoId: created.saoId,
      outcome: created.outcome,
      occurredAt: created.occurredAt.toISOString(),
      source: created.source,
      evidenceRef: created.evidenceRef,
      note: created.note,
      createdAt: created.createdAt.toISOString(),
    };
  }
}

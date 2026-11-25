import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  evaluateT0Channels,
  maskEmailLocalPart,
  type T0ChannelKey,
  type T0ConsentState,
  type T0EvaluationResult,
} from '@gain-saas/shared';
import { PrismaService } from '../shared/prisma.service.js';
import { OUTREACH_DNC_CHECKER, type OutreachTenant } from './outreach-consent.service.js';
import type { OutreachDncChecker } from './outreach-dnc.checker.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const T0_TOUCH_ACTION = 'outreach.t0.touch';
const ALLOWED_CHANNELS = new Set<T0ChannelKey>(['mailto', 'linkedin', 'whatsapp', 'form']);
const ALLOWED_OUTCOMES = new Set(['OPENED', 'COPIED', 'SENT', 'REPLIED'] as const);

export type T0TouchOutcome = 'OPENED' | 'COPIED' | 'SENT' | 'REPLIED';

export interface T0CheckInput {
  leadId: string;
  contactRef?: string | null;
  countryCode?: string | null;
  companyName?: string | null;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  whatsappUrl?: string | null;
  linkedinUrl?: string | null;
  formUrl?: string | null;
  leadStatus?: string | null;
  sanctionsHold?: boolean;
}

export interface T0CheckResponse extends T0EvaluationResult {
  consentStatus: T0ConsentState;
  suppressionReasons: string[];
}

export interface T0TouchInput {
  leadId: string;
  channel: T0ChannelKey;
  target?: string | null;
  note?: string | null;
  outcome?: T0TouchOutcome;
}

export interface T0TouchView {
  id: string;
  leadId: string;
  channel: T0ChannelKey;
  targetMasked: string | null;
  note: string | null;
  outcome: T0TouchOutcome;
  actorId: string;
  createdAt: string;
}

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

function maskT0Target(target: string | null | undefined): string | null {
  const trimmed = (target ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.includes('@') && !/^https?:\/\//i.test(trimmed)) {
    return maskEmailLocalPart(trimmed);
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return `${parsed.origin}${parsed.pathname}`.slice(0, 200);
    } catch {
      return trimmed.slice(0, 120);
    }
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length >= 6) {
    return `***${digits.slice(-4)}`;
  }
  return trimmed.slice(0, 120);
}

/**
 * T0 四通道轻外联服务：
 * - `check`：在服务端实时结合租户/平台 DNC 禁联名单、同意台账（OPT_OUT/OPT_IN）与 D3 法域规则，
 *   对任意租户成员（含普通成员）输出确定性 4 通道合规门禁（DNC 查询异常 fail-closed）；
 * - `recordTouch` / `listTouches`：记录并查询轻量人工触达留痕（个人邮箱本地部分脱敏，按 workspace 隔离）。
 */
@Injectable()
export class OutreachT0Service {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OUTREACH_DNC_CHECKER) private readonly dnc: OutreachDncChecker,
  ) {}

  async check(tenant: OutreachTenant, input: T0CheckInput): Promise<T0CheckResponse> {
    if (!UUID_RE.test(input.leadId)) invalid('leadId must be a UUID');
    const consentTarget = input.contactRef && UUID_RE.test(input.contactRef)
      ? input.contactRef
      : input.leadId;

    const latestConsent = await this.prisma.withWorkspace(tenant.workspaceId, (tx) =>
      tx.outreachConsent.findFirst({
        where: {
          workspaceId: tenant.workspaceId,
          contactRef: consentTarget,
          channel: 'email',
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    const consentStatus: T0ConsentState =
      (latestConsent?.status as T0ConsentState | undefined) ?? 'MISSING';

    const suppressionReasons: string[] = [];
    if ((input.leadStatus ?? '').trim().toUpperCase() === 'SUPPRESSED') {
      suppressionReasons.push('lead:suppressed');
    }
    if (consentStatus === 'OPT_OUT') {
      suppressionReasons.push('consent:opt_out');
    }

    let dncCheckFailed = false;
    const cleanEmail = (input.email ?? '').trim().toLowerCase();
    if (cleanEmail && cleanEmail.includes('@')) {
      try {
        const hits = await this.dnc.check(tenant, [cleanEmail]);
        const reasons = hits.get(cleanEmail) ?? [];
        for (const reason of reasons) {
          if (!suppressionReasons.includes(reason)) {
            suppressionReasons.push(reason);
          }
        }
      } catch {
        dncCheckFailed = true;
      }
    }

    const evaluation = evaluateT0Channels({
      countryCode: input.countryCode,
      companyName: input.companyName,
      contactName: input.contactName,
      email: input.email,
      phone: input.phone,
      whatsappUrl: input.whatsappUrl,
      linkedinUrl: input.linkedinUrl,
      formUrl: input.formUrl,
      consentStatus,
      suppressed: suppressionReasons.length > 0,
      sanctionsHold: Boolean(input.sanctionsHold),
      dncCheckFailed,
    });

    return {
      ...evaluation,
      consentStatus,
      suppressionReasons,
    };
  }

  async recordTouch(tenant: OutreachTenant, input: T0TouchInput): Promise<T0TouchView> {
    if (!UUID_RE.test(input.leadId)) invalid('leadId must be a UUID');
    if (!ALLOWED_CHANNELS.has(input.channel)) {
      invalid('channel 必须是 mailto / linkedin / whatsapp / form');
    }
    const outcome: T0TouchOutcome = input.outcome ?? 'OPENED';
    if (!ALLOWED_OUTCOMES.has(outcome)) {
      invalid('outcome 不合法');
    }
    const note = input.note?.trim().slice(0, 500) || null;
    const targetMasked = maskT0Target(input.target);

    const row = await this.prisma.auditLog.create({
      data: {
        realm: 'tenant',
        actorId: tenant.userId,
        workspaceId: tenant.workspaceId,
        action: T0_TOUCH_ACTION,
        target: input.leadId,
        detail: {
          workspaceId: tenant.workspaceId,
          channel: input.channel,
          targetMasked,
          note,
          outcome,
        } as Prisma.InputJsonValue,
      },
    });

    return {
      id: row.id,
      leadId: input.leadId,
      channel: input.channel,
      targetMasked,
      note,
      outcome,
      actorId: row.actorId,
      createdAt: row.at instanceof Date ? row.at.toISOString() : String(row.at),
    };
  }

  async listTouches(tenant: OutreachTenant, leadId: string): Promise<T0TouchView[]> {
    if (!UUID_RE.test(leadId)) invalid('leadId must be a UUID');
    const rows = await this.prisma.auditLog.findMany({
      where: {
        realm: 'tenant',
        workspaceId: tenant.workspaceId,
        action: T0_TOUCH_ACTION,
        target: leadId,
      },
      orderBy: { at: 'desc' },
      take: 50,
    });

    const views: T0TouchView[] = [];
    for (const row of rows) {
      const detail = (row.detail ?? null) as Record<string, unknown> | null;
      if (!detail || detail.workspaceId !== tenant.workspaceId) continue;
      const channel = detail.channel as T0ChannelKey;
      if (!ALLOWED_CHANNELS.has(channel)) continue;
      const outcome = (detail.outcome as T0TouchOutcome | undefined) ?? 'OPENED';
      views.push({
        id: row.id,
        leadId,
        channel,
        targetMasked: typeof detail.targetMasked === 'string' ? detail.targetMasked : null,
        note: typeof detail.note === 'string' ? detail.note : null,
        outcome: ALLOWED_OUTCOMES.has(outcome) ? outcome : 'OPENED',
        actorId: row.actorId,
        createdAt: row.at instanceof Date ? row.at.toISOString() : String(row.at),
      });
    }
    return views;
  }
}

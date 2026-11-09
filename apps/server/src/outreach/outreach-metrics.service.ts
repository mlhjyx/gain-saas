import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';

export const METRICS_DEFINITION_VERSION = 'outreach-metrics/v1';

export interface WilsonInterval {
  low: number;
  high: number;
}

/**
 * Wilson 95% 区间（ch05 §5.3.7.4：小样本与接近 0/1 时禁止正态近似）。
 * 分母为 0 返回 null。z 默认 1.96。
 */
export function wilsonInterval(
  numerator: number,
  denominator: number,
  z = 1.96,
): WilsonInterval | null {
  if (denominator <= 0) return null;
  const p = numerator / denominator;
  const z2 = z * z;
  const center = (p + z2 / (2 * denominator)) / (1 + z2 / denominator);
  const margin =
    (z * Math.sqrt((p * (1 - p)) / denominator + z2 / (4 * denominator * denominator))) /
    (1 + z2 / denominator);
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

export interface EmailWindowMetrics {
  windowStart: Date;
  windowEnd: Date;
  definitionVersion: string;
  sent: number;
  hardBounces: number;
  dsnBounces: number;
  complaints: number;
  replies: number;
  unsubscribes: number;
  optOuts: number;
  meetings: number;
  costMicros: number;
  rates: {
    hardBounceRate: { value: number | null; wilson95: WilsonInterval | null };
    complaintRate: { value: number | null; wilson95: WilsonInterval | null };
    replyRate: { value: number | null; wilson95: WilsonInterval | null };
    optOutRate: { value: number | null; wilson95: WilsonInterval | null };
  };
}

function rate(numerator: number, denominator: number) {
  return {
    value: denominator > 0 ? numerator / denominator : null,
    wilson95: wilsonInterval(numerator, denominator),
  };
}

/**
 * 触达指标与成本报表（P4-09，ch05 §5.3.6/§5.3.7.4）。
 * 口径（definitionVersion=outreach-metrics/v1）：
 * - 退信率分子 = SMTP 硬拒（send.bounce_type=HARD）+ DSN 退信；分母 = SENT + 硬拒；
 * - 投诉率分子 = outreach_reply COMPLAINT；分母 = SENT；
 * - 回复率分子 = outreach_reply REPLY（含后续分类前的原始回复）；分母 = SENT；
 * - 退订率分子 = 窗口内 outreach_reply UNSUBSCRIBE；分母 = SENT；
 * - 会议数 = 窗口内 MEETING_BOOKED outcome（工作空间级；campaign/账户归因需 QGO.campaignId 链，见 evidence）；
 * - 成本 = SENT × OUTREACH_COST_PER_EMAIL_MICROS（全载摊销口径，labor 未计）。
 */
@Injectable()
export class OutreachMetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async computeWindow(
    tenant: OutreachTenant,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<EmailWindowMetrics> {
    const [sent, hardBounces, dsnBounces, complaints, replies, unsubscribes, optOuts, meetings] =
      await Promise.all([
        this.prisma.outreachSend.count({
          where: {
            workspaceId: tenant.workspaceId,
            status: 'SENT',
            sentAt: { gte: windowStart, lt: windowEnd },
          },
        }),
        this.prisma.outreachSend.count({
          where: {
            workspaceId: tenant.workspaceId,
            status: 'FAILED',
            bounceType: 'HARD',
            createdAt: { gte: windowStart, lt: windowEnd },
          },
        }),
        this.prisma.outreachReply.count({
          where: {
            workspaceId: tenant.workspaceId,
            kind: 'BOUNCE',
            receivedAt: { gte: windowStart, lt: windowEnd },
          },
        }),
        this.prisma.outreachReply.count({
          where: {
            workspaceId: tenant.workspaceId,
            kind: 'COMPLAINT',
            receivedAt: { gte: windowStart, lt: windowEnd },
          },
        }),
        this.prisma.outreachReply.count({
          where: {
            workspaceId: tenant.workspaceId,
            kind: 'REPLY',
            receivedAt: { gte: windowStart, lt: windowEnd },
          },
        }),
        this.prisma.outreachReply.count({
          where: {
            workspaceId: tenant.workspaceId,
            kind: 'UNSUBSCRIBE',
            receivedAt: { gte: windowStart, lt: windowEnd },
          },
        }),
        this.prisma.outreachConsent.count({
          where: {
            workspaceId: tenant.workspaceId,
            channel: 'email',
            status: 'OPT_OUT',
            createdAt: { gte: windowStart, lt: windowEnd },
          },
        }),
        this.prisma.opportunityOutcome.count({
          where: {
            workspaceId: tenant.workspaceId,
            outcome: 'MEETING_BOOKED',
            occurredAt: { gte: windowStart, lt: windowEnd },
          },
        }),
      ]);
    const attempts = sent + hardBounces;
    return {
      windowStart,
      windowEnd,
      definitionVersion: METRICS_DEFINITION_VERSION,
      sent,
      hardBounces,
      dsnBounces,
      complaints,
      replies,
      unsubscribes,
      optOuts,
      meetings,
      costMicros: sent * this.config.OUTREACH_COST_PER_EMAIL_MICROS,
      rates: {
        hardBounceRate: rate(hardBounces + dsnBounces, attempts),
        complaintRate: rate(complaints, sent),
        replyRate: rate(replies, sent),
        optOutRate: rate(unsubscribes, sent),
      },
    };
  }

  /** 成本报表：窗口默认 OUTREACH_METRICS_WINDOW_DAYS；每会议成本在无会议时为 null。 */
  async costReport(tenant: OutreachTenant, windowDays?: number, now = new Date()) {
    const days = windowDays ?? this.config.OUTREACH_METRICS_WINDOW_DAYS;
    const windowEnd = now;
    const windowStart = new Date(now.getTime() - days * 86_400_000);
    const metrics = await this.computeWindow(tenant, windowStart, windowEnd);
    return {
      channel: 'email',
      windowDays: days,
      definitionVersion: METRICS_DEFINITION_VERSION,
      metrics,
      costPerMeetingMicros:
        metrics.meetings > 0 ? Math.round(metrics.costMicros / metrics.meetings) : null,
      costPerSentMicros: metrics.sent > 0 ? Math.round(metrics.costMicros / metrics.sent) : null,
      limitations: [
        'labor 工时未计入（laborHours=null）；成本为发送全载摊销口径',
        '会议数为工作空间级 MEETING_BOOKED；campaign/账户归因需 QGO.campaignId 链（后续卡片）',
        '回复率为原始 REPLY（分类前的保守口径）',
      ],
    };
  }

  /** 指标快照落库（周报只读）：每指标一行，含成本与口径版本。 */
  async snapshot(
    tenant: OutreachTenant,
    options: { windowDays?: number; now?: Date } = {},
  ) {
    const now = options.now ?? new Date();
    const days = options.windowDays ?? this.config.OUTREACH_METRICS_WINDOW_DAYS;
    const windowStart = new Date(now.getTime() - days * 86_400_000);
    const metrics = await this.computeWindow(tenant, windowStart, now);
    const attempts = metrics.sent + metrics.hardBounces;
    const rows = [
      { metric: 'sent', numerator: metrics.sent, denominator: 1 },
      { metric: 'delivered', numerator: metrics.sent, denominator: 1 },
      {
        metric: 'hard_bounce_rate',
        numerator: metrics.hardBounces + metrics.dsnBounces,
        denominator: attempts,
      },
      { metric: 'complaint_rate', numerator: metrics.complaints, denominator: metrics.sent },
      { metric: 'reply_rate', numerator: metrics.replies, denominator: metrics.sent },
      { metric: 'opt_out_rate', numerator: metrics.unsubscribes, denominator: metrics.sent },
      {
        metric: 'cost_per_meeting',
        numerator: metrics.costMicros,
        denominator: metrics.meetings,
      },
    ];
    const created = [];
    for (const row of rows) {
      created.push(
        await this.prisma.outreachMetricSnapshot.create({
          data: {
            workspaceId: tenant.workspaceId,
            channel: 'email',
            metric: row.metric,
            numerator: row.numerator,
            denominator: row.denominator,
            windowStart,
            windowEnd: now,
            definitionVersion: METRICS_DEFINITION_VERSION,
            costMicros: metrics.costMicros,
          },
        }),
      );
    }
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.metrics.snapshot',
      target: tenant.workspaceId,
      detail: { windowDays: days, definitionVersion: METRICS_DEFINITION_VERSION },
    });
    return created;
  }
}

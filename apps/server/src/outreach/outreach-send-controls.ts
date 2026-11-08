import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import { normalizeCountry } from './outreach-jurisdiction.js';

/**
 * 收件人国家 → 默认时区（第 5 章 §5.3.5.4：无法确定时按国家默认时区 + 保守窗口）。
 * 用 IANA 时区（Intl 解析），窗口判定天然覆盖 DST，不用固定 offset。
 */
const COUNTRY_TIMEZONE: Record<string, string> = {
  DE: 'Europe/Berlin',
  AT: 'Europe/Vienna',
  FR: 'Europe/Paris',
  US: 'America/New_York',
};
const DEFAULT_TIMEZONE = 'Europe/Berlin';

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

export interface RecipientLocalTime {
  timezone: string;
  /** 1=周一 … 7=周日 */
  weekday: number;
  /** 当地小时 × 60 + 分钟 */
  minutes: number;
}

export function recipientLocalTime(countryCode: unknown, now: Date): RecipientLocalTime {
  const timezone = COUNTRY_TIMEZONE[normalizeCountry(countryCode)] ?? DEFAULT_TIMEZONE;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  return { timezone, weekday: WEEKDAY_INDEX[get('weekday')] ?? 0, minutes: hour * 60 + minute };
}

export interface DraftControlInput {
  recipientEmail: string;
  countryCode: unknown;
  now: Date;
}

export type DraftControlVerdict =
  | { action: 'SEND' }
  | { action: 'DEFER'; code: string };

/**
 * 单批发送期间的控制面状态：开始前从台账恢复计数，发送成功后递进。
 * v1 为进程内状态 + 台账回读（无 outreach_mailbox_counter 表；表驱动版在 P4-02 完整落地）。
 */
export interface BatchControlState {
  mailboxAddress: string;
  dailySent: number;
  weeklySent: number;
  /** 本小时各收件域已发送数（含本批已成功发送）。 */
  hourlyByDomain: Map<string, number>;
}

function parseWindowMinutes(value: string, fallback: number): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseWeekdays(value: string): Set<number> {
  const days = value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
  return new Set(days.length > 0 ? days : [1, 2, 3, 4, 5]);
}

/**
 * 发送前控制面校验（第 5 章 P4-02 的服务层 v1，全部来自 env 配置的保守默认值）：
 * 信箱日/周上限、收件人当地发送窗口、同收件域每小时限速、退信/投诉熔断。
 * 拒绝/顺延只返回结论，写审计与台账由发送服务统一负责。
 */
@Injectable()
export class OutreachSendControls {
  private readonly dailyCap: number;
  private readonly weeklyCap: number;
  private readonly domainHourlyCap: number;
  private readonly windowStart: number;
  private readonly windowEnd: number;
  private readonly weekdays: Set<number>;
  private readonly bounceWindowDays: number;
  private readonly bounceMinSample: number;
  private readonly bounceRateHalt: number;
  private readonly complaintMinSample: number;
  private readonly complaintRateHalt: number;

  private readonly mailbox: string;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.mailbox = config.OUTREACH_SMTP_FROM_ADDRESS ?? 'unconfigured';
    this.dailyCap = config.OUTREACH_MAILBOX_DAILY_CAP;
    this.weeklyCap = config.OUTREACH_MAILBOX_WEEKLY_CAP;
    this.domainHourlyCap = config.OUTREACH_DOMAIN_HOURLY_CAP;
    this.windowStart = parseWindowMinutes(config.OUTREACH_SEND_WINDOW_START, 9 * 60);
    this.windowEnd = parseWindowMinutes(config.OUTREACH_SEND_WINDOW_END, 17 * 60);
    this.weekdays = parseWeekdays(config.OUTREACH_SEND_WEEKDAYS);
    this.bounceWindowDays = config.OUTREACH_BOUNCE_WINDOW_DAYS;
    this.bounceMinSample = config.OUTREACH_BOUNCE_MIN_SAMPLE;
    this.bounceRateHalt = config.OUTREACH_BOUNCE_RATE_HALT;
    this.complaintMinSample = config.OUTREACH_COMPLAINT_MIN_SAMPLE;
    this.complaintRateHalt = config.OUTREACH_COMPLAINT_RATE_HALT;
  }

  /**
   * 批次级熔断检查：滚动窗口内退信率/投诉率超阈值即整批停发（fail-closed）。
   * 恢复不是自动的：阈值按时间窗口自然滚动消解，人工解除见 P4-08 完整熔断器。
   */
  async assertHealthy(tenant: OutreachTenant, now: Date = new Date()): Promise<void> {
    const since = new Date(now.getTime() - this.bounceWindowDays * 86_400_000);
    const [sends, bounces, complaints] = await Promise.all([
      this.prisma.outreachSend.count({
        where: {
          workspaceId: tenant.workspaceId,
          status: 'SENT',
          sentAt: { gte: since },
        },
      }),
      this.prisma.outreachReply.count({
        where: {
          workspaceId: tenant.workspaceId,
          kind: 'BOUNCE',
          receivedAt: { gte: since },
        },
      }),
      this.prisma.outreachReply.count({
        where: {
          workspaceId: tenant.workspaceId,
          kind: 'COMPLAINT',
          receivedAt: { gte: since },
        },
      }),
    ]);
    if (sends >= this.bounceMinSample && bounces / sends >= this.bounceRateHalt) {
      throw new ConflictException({
        error: {
          code: 'OUTREACH_MAILBOX_PAUSED',
          message: `滚动 ${this.bounceWindowDays} 天退信率 ${(bounces / sends * 100).toFixed(1)}% 超过 ${(this.bounceRateHalt * 100).toFixed(1)}% 熔断线，整批停发`,
        },
      });
    }
    if (sends >= this.complaintMinSample && complaints / sends >= this.complaintRateHalt) {
      throw new ConflictException({
        error: {
          code: 'OUTREACH_DOMAIN_PAUSED',
          message: `滚动 ${this.bounceWindowDays} 天投诉率 ${(complaints / sends * 100).toFixed(2)}% 超过 ${(this.complaintRateHalt * 100).toFixed(2)}% 红线，整批停发`,
        },
      });
    }
  }

  /** 从发送台账恢复本批开始时的计数器（日/周按发件信箱，小时按收件域）。 */
  async beginBatch(tenant: OutreachTenant, now: Date): Promise<BatchControlState> {
    const mailboxAddress = this.mailboxAddress();
    const dayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const weekStart = new Date(now.getTime() - 7 * 86_400_000);
    const hourStart = new Date(now.getTime() - 3_600_000);
    const [dailySent, weeklySent, hourlyRows] = await Promise.all([
      this.prisma.outreachSend.count({
        where: {
          workspaceId: tenant.workspaceId,
          mailboxAddress,
          status: 'SENT',
          sentAt: { gte: dayStart },
        },
      }),
      this.prisma.outreachSend.count({
        where: {
          workspaceId: tenant.workspaceId,
          mailboxAddress,
          status: 'SENT',
          sentAt: { gte: weekStart },
        },
      }),
      this.prisma.outreachSend.findMany({
        where: {
          workspaceId: tenant.workspaceId,
          mailboxAddress,
          status: 'SENT',
          sentAt: { gte: hourStart },
        },
        select: { recipientEmail: true },
      }),
    ]);
    const hourlyByDomain = new Map<string, number>();
    for (const row of hourlyRows as Array<{ recipientEmail: string }>) {
      const domain = row.recipientEmail.split('@')[1]?.toLowerCase();
      if (!domain) continue;
      hourlyByDomain.set(domain, (hourlyByDomain.get(domain) ?? 0) + 1);
    }
    return { mailboxAddress, dailySent, weeklySent, hourlyByDomain };
  }

  /**
   * 逐封校验：信箱上限 → 发送窗口 → 同收件域限速。
   * 全部返回顺延（DEFER）：上限/窗口/限速都是临时的，草稿保持待发，等额度或窗口恢复；
   * 永久性拒绝（OPT_OUT/DNC/法域）在发送服务的预检里已先行判定，不经过这里。
   */
  checkDraft(state: BatchControlState, input: DraftControlInput): DraftControlVerdict {
    if (state.dailySent >= this.dailyCap) {
      return { action: 'DEFER', code: 'OUTREACH_MAILBOX_DAILY_CAP' };
    }
    if (state.weeklySent >= this.weeklyCap) {
      return { action: 'DEFER', code: 'OUTREACH_MAILBOX_WEEKLY_CAP' };
    }
    const local = recipientLocalTime(input.countryCode, input.now);
    if (!this.weekdays.has(local.weekday)) {
      return { action: 'DEFER', code: 'OUTREACH_WINDOW_CLOSED' };
    }
    if (this.windowStart >= this.windowEnd) {
      return { action: 'DEFER', code: 'OUTREACH_WINDOW_CLOSED' };
    }
    if (local.minutes < this.windowStart || local.minutes >= this.windowEnd) {
      return { action: 'DEFER', code: 'OUTREACH_WINDOW_CLOSED' };
    }
    const domain = input.recipientEmail.split('@')[1]?.toLowerCase() ?? '';
    if (domain && (state.hourlyByDomain.get(domain) ?? 0) >= this.domainHourlyCap) {
      return { action: 'DEFER', code: 'OUTREACH_DOMAIN_RATE_LIMITED' };
    }
    return { action: 'SEND' };
  }

  /** 一封真正投递成功后递进计数（失败/顺延/跳过不占额度）。 */
  recordSent(state: BatchControlState, recipientEmail: string): void {
    state.dailySent += 1;
    state.weeklySent += 1;
    const domain = recipientEmail.split('@')[1]?.toLowerCase();
    if (domain) {
      state.hourlyByDomain.set(domain, (state.hourlyByDomain.get(domain) ?? 0) + 1);
    }
  }

  mailboxAddress(): string {
    return this.mailbox;
  }
}

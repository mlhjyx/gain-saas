import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { AuditService } from '../shared/audit.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const WARMUP_STAGES = ['W1', 'W2', 'W3', 'MATURE'] as const;
export type WarmupStage = (typeof WARMUP_STAGES)[number];
const MAILBOX_STATES = ['ACTIVE', 'PAUSED', 'RETIRED'] as const;
type MailboxState = (typeof MAILBOX_STATES)[number];

/** warmup 阶梯的默认日/周上限（ch05 §5.3.3.3；扩量靠加信箱，不提高单箱上限）。 */
export const WARMUP_STAGE_CAPS: Record<WarmupStage, { daily: number; weekly: number }> = {
  W1: { daily: 10, weekly: 50 },
  W2: { daily: 20, weekly: 100 },
  W3: { daily: 30, weekly: 150 },
  MATURE: { daily: 40, weekly: 200 },
};

export interface OutreachMailboxInput {
  address?: unknown;
  displayName?: unknown;
  provider?: unknown;
  warmupStage?: unknown;
  dailyCap?: unknown;
  weeklyCap?: unknown;
  timezone?: unknown;
  state?: unknown;
}

export interface OutboxUsage {
  dailySent: number;
  weeklySent: number;
}

function invalid(message: string): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}
function notFound(): never {
  throw new NotFoundException({
    error: { code: 'OUTREACH_MAILBOX_NOT_FOUND', message: '发件信箱不存在' },
  });
}
function conflict(code: string, message: string): never {
  throw new ConflictException({ error: { code, message } });
}

function utcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function domainOf(address: string): string {
  return address.split('@')[1]?.toLowerCase() ?? '';
}

function recipientDomainOf(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? '';
}

/**
 * 发件资产（P4-02）：域名/信箱/日周配额计数/warmup 阶梯。
 * 发送路径用它取生效上限并在成功后落计数；管理端点（AdminGuard）维护资产。
 * 兼容「单信箱降级模式」：OUTREACH_SMTP_FROM_ADDRESS 指向的信箱会被懒创建为 MATURE，
 * 上限取 env 默认值，行为与 v1（env + 台账回读）一致。
 */
@Injectable()
export class OutreachMailboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** 当前默认发件信箱 + 今日/本周用量 + warmup 阶梯上限（运营台 checklist 读它）。 */
  async summary(tenant: OutreachTenant, now: Date = new Date()) {
    const mailbox = await this.ensureDefaultMailbox(
      tenant.workspaceId,
      this.config.OUTREACH_SMTP_FROM_ADDRESS,
      {
        dailyCap: this.config.OUTREACH_MAILBOX_DAILY_CAP,
        weeklyCap: this.config.OUTREACH_MAILBOX_WEEKLY_CAP,
      },
    );
    if (!mailbox) return { mailbox: null, usage: null, warmupCaps: null };
    const usage = await this.usage(mailbox.id, now);
    return {
      mailbox,
      usage,
      warmupCaps:
        WARMUP_STAGE_CAPS[mailbox.warmupStage as WarmupStage] ?? WARMUP_STAGE_CAPS.MATURE,
    };
  }

  /** 懒创建并返回当前发件信箱（单信箱降级模式的落库化）；未配置地址时返回 null。 */
  async ensureDefaultMailbox(
    workspaceId: string,
    fromAddress: string | undefined,
    options: { dailyCap?: number; weeklyCap?: number } = {},
  ) {
    if (!fromAddress || !EMAIL_RE.test(fromAddress)) return null;
    const address = fromAddress.trim().toLowerCase();
    const domain = await this.ensureDomain(workspaceId, domainOf(address), 'cold_outbound');
    const existing = await this.prisma.outreachMailbox.findUnique({
      where: { workspaceId_address: { workspaceId, address } },
    });
    if (existing) return existing;
    try {
      return await this.prisma.outreachMailbox.create({
        data: {
          workspaceId,
          domainId: domain.id,
          address,
          displayName: address.split('@')[0] ?? address,
          provider: 'smtp',
          // 存量单信箱：保持 v1 行为（MATURE + env 上限），不因引入资产表而突然降到 W1。
          warmupStage: 'MATURE',
          dailyCap: options.dailyCap ?? 30,
          weeklyCap: options.weeklyCap ?? 120,
          timezone: 'Europe/Berlin',
          state: 'ACTIVE',
          healthState: 'CLOSED',
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.prisma.outreachMailbox.findUnique({
          where: { workspaceId_address: { workspaceId, address } },
        });
      }
      throw error;
    }
  }

  /** 当前日/周已发送数（来自落库计数，P4-02）。 */
  async usage(mailboxId: string, now: Date): Promise<OutboxUsage> {
    const day = utcDay(now);
    const weekStart = new Date(day.getTime() - 6 * 86_400_000);
    const [today, week] = await Promise.all([
      this.prisma.outreachMailboxCounter.findUnique({
        where: { mailboxId_day: { mailboxId, day } },
      }),
      this.prisma.outreachMailboxCounter.aggregate({
        where: { mailboxId, day: { gte: weekStart } },
        _sum: { sent: true },
      }),
    ]);
    return { dailySent: today?.sent ?? 0, weeklySent: week._sum.sent ?? 0 };
  }

  /** 一封发送成功后原子递增日计数与「发件域×收件域」小时计数。 */
  async recordSend(
    mailbox: { id: string; domainId: string },
    recipientEmail: string,
    now: Date,
  ): Promise<void> {
    const day = utcDay(now);
    const hour = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        now.getUTCHours(),
      ),
    );
    const recipientDomain = recipientDomainOf(recipientEmail);
    await this.prisma.$transaction([
      this.prisma.outreachMailboxCounter.upsert({
        where: { mailboxId_day: { mailboxId: mailbox.id, day } },
        create: { mailboxId: mailbox.id, day, sent: 1 },
        update: { sent: { increment: 1 } },
      }),
      this.prisma.outreachDomainCounter.upsert({
        where: {
          domainId_hour_recipientDomain: {
            domainId: mailbox.domainId,
            hour,
            recipientDomain,
          },
        },
        create: { domainId: mailbox.domainId, hour, recipientDomain, sent: 1 },
        update: { sent: { increment: 1 } },
      }),
      this.prisma.outreachMailbox.update({
        where: { id: mailbox.id },
        data: { lastSendAt: now },
      }),
    ]);
  }

  /** 硬拒绝（5xx）记入信箱当日计数，供未来按信箱熔断读取。 */
  async recordHardBounce(mailboxId: string, now: Date): Promise<void> {
    const day = utcDay(now);
    await this.prisma.outreachMailboxCounter.upsert({
      where: { mailboxId_day: { mailboxId, day } },
      create: { mailboxId, day, hardBounces: 1 },
      update: { hardBounces: { increment: 1 } },
    });
  }

  async listMailboxes(tenant: OutreachTenant) {
    return this.prisma.outreachMailbox.findMany({
      where: { workspaceId: tenant.workspaceId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createMailbox(tenant: OutreachTenant, input: OutreachMailboxInput) {
    const normalized = this.normalize(input, { partial: false });
    const domain = await this.ensureDomain(tenant.workspaceId, domainOf(normalized.address));
    try {
      const mailbox = await this.prisma.outreachMailbox.create({
        data: {
          workspaceId: tenant.workspaceId,
          domainId: domain.id,
          address: normalized.address,
          displayName: normalized.displayName ?? '',
          provider: normalized.provider ?? 'smtp',
          warmupStage: normalized.warmupStage ?? 'W1',
          dailyCap: normalized.dailyCap ?? this.config.OUTREACH_MAILBOX_DAILY_CAP,
          weeklyCap: normalized.weeklyCap ?? this.config.OUTREACH_MAILBOX_WEEKLY_CAP,
          timezone: normalized.timezone ?? 'Europe/Berlin',
          state: normalized.state ?? 'ACTIVE',
        },
      });
      await this.audit.record({
        realm: 'tenant',
        actorId: tenant.userId,
        action: 'outreach.mailbox.created',
        target: mailbox.id,
        detail: { address: mailbox.address, warmupStage: mailbox.warmupStage },
      });
      return mailbox;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        conflict('OUTREACH_MAILBOX_DUPLICATE', '该发件信箱已存在');
      }
      throw error;
    }
  }

  async updateMailbox(tenant: OutreachTenant, mailboxId: string, input: OutreachMailboxInput) {
    if (!UUID_RE.test(mailboxId)) notFound();
    const existing = await this.prisma.outreachMailbox.findFirst({
      where: { id: mailboxId, workspaceId: tenant.workspaceId },
    });
    if (!existing) notFound();
    const normalized = this.normalize(input, { partial: true });
    if (normalized.address && normalized.address !== existing.address) {
      invalid('不允许修改发件地址；请新建信箱并停用旧信箱');
    }
    const updated = await this.prisma.outreachMailbox.update({
      where: { id: mailboxId },
      data: {
        ...(normalized.displayName !== undefined
          ? { displayName: normalized.displayName }
          : {}),
        ...(normalized.provider !== undefined ? { provider: normalized.provider } : {}),
        ...(normalized.warmupStage !== undefined
          ? { warmupStage: normalized.warmupStage }
          : {}),
        ...(normalized.dailyCap !== undefined ? { dailyCap: normalized.dailyCap } : {}),
        ...(normalized.weeklyCap !== undefined ? { weeklyCap: normalized.weeklyCap } : {}),
        ...(normalized.timezone !== undefined ? { timezone: normalized.timezone } : {}),
        ...(normalized.state !== undefined ? { state: normalized.state } : {}),
      },
    });
    await this.audit.record({
      realm: 'tenant',
      actorId: tenant.userId,
      action: 'outreach.mailbox.updated',
      target: mailboxId,
      detail: {
        warmupStage: updated.warmupStage,
        state: updated.state,
        dailyCap: updated.dailyCap,
        weeklyCap: updated.weeklyCap,
      },
    });
    return updated;
  }

  private async ensureDomain(workspaceId: string, domain: string, kind = 'cold_outbound') {
    return this.prisma.outreachDomain.upsert({
      where: { workspaceId_domain: { workspaceId, domain } },
      create: { workspaceId, domain, kind, state: 'ACTIVE' },
      update: {},
    });
  }

  private normalize(input: OutreachMailboxInput, options: { partial: boolean }) {
    const address = typeof input.address === 'string' ? input.address.trim().toLowerCase() : '';
    if (!options.partial || input.address !== undefined) {
      if (!EMAIL_RE.test(address) || address.length > 320) invalid('发件邮箱不合法');
    }
    const displayName =
      typeof input.displayName === 'string' ? input.displayName.trim() : undefined;
    if (!options.partial || input.displayName !== undefined) {
      if (!displayName || displayName.length > 200) invalid('显示名必填且不超过 200 字');
    }
    let provider: string | undefined;
    if (input.provider !== undefined) {
      provider = typeof input.provider === 'string' ? input.provider.trim().slice(0, 32) : '';
      if (!provider) invalid('provider 不合法');
    } else if (!options.partial) {
      provider = 'smtp';
    }

    let warmupStage: WarmupStage | undefined;
    if (input.warmupStage !== undefined) {
      if (
        typeof input.warmupStage !== 'string' ||
        !(WARMUP_STAGES as readonly string[]).includes(input.warmupStage)
      ) {
        invalid('warmupStage 必须是 W1/W2/W3/MATURE');
      }
      warmupStage = input.warmupStage as WarmupStage;
    } else if (!options.partial) {
      warmupStage = 'W1';
    }
    // 显式给了上限就用给的；只改 warmup 阶梯时按新阶梯重置默认上限；partial 且两者都没给则不触碰。
    const stageCaps = WARMUP_STAGE_CAPS[warmupStage ?? 'W1'];
    const capsDefault = options.partial && warmupStage === undefined ? undefined : stageCaps;
    const dailyCap =
      input.dailyCap !== undefined
        ? this.positiveInt(input.dailyCap, stageCaps.daily, 'dailyCap', 500)
        : capsDefault?.daily;
    const weeklyCap =
      input.weeklyCap !== undefined
        ? this.positiveInt(input.weeklyCap, stageCaps.weekly, 'weeklyCap', 2000)
        : capsDefault?.weekly;
    let timezone: string | undefined;
    if (input.timezone !== undefined) {
      if (typeof input.timezone !== 'string' || !input.timezone.trim()) {
        invalid('timezone 不合法');
      }
      timezone = input.timezone.trim().slice(0, 64);
    } else if (!options.partial) {
      timezone = 'Europe/Berlin';
    }
    let state: MailboxState | undefined;
    if (input.state !== undefined) {
      if (
        typeof input.state !== 'string' ||
        !(MAILBOX_STATES as readonly string[]).includes(input.state)
      ) {
        invalid('state 必须是 ACTIVE/PAUSED/RETIRED');
      }
      state = input.state as MailboxState;
    } else if (!options.partial) {
      state = 'ACTIVE';
    }
    return {
      address,
      displayName,
      provider,
      warmupStage,
      dailyCap,
      weeklyCap,
      timezone,
      state,
    };
  }

  private positiveInt(value: unknown, fallback: number, field: string, max: number): number {
    if (value === undefined || value === null) return fallback;
    const num = typeof value === 'string' ? Number(value) : value;
    if (typeof num !== 'number' || !Number.isInteger(num) || num < 1 || num > max) {
      invalid(`${field} 必须是 1..${max} 的整数`);
    }
    return num;
  }
}

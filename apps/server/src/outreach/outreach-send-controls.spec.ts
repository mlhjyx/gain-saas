import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import {
  OutreachSendControls,
  recipientLocalTime,
} from './outreach-send-controls.js';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenant: OutreachTenant = { userId: 'user-a', workspaceId: WS, role: 'admin' };

interface Row {
  [key: string]: unknown;
}

class FakeControlsPrisma {
  sends: Row[] = [];
  replies: Row[] = [];

  readonly outreachSend = {
    count: async ({ where }: { where: Row }) =>
      this.sends.filter((row) => matches(row, where)).length,
    findMany: async ({ where }: { where: Row }) =>
      this.sends.filter((row) => matches(row, where)),
  };

  readonly outreachReply = {
    count: async ({ where }: { where: Row }) =>
      this.replies.filter((row) => matches(row, where)).length,
  };
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      const obj = condition as Record<string, unknown>;
      if ('gte' in obj) {
        return (row[key] as Date).getTime() >= (obj.gte as Date).getTime();
      }
      if ('lt' in obj) {
        return (row[key] as Date).getTime() < (obj.lt as Date).getTime();
      }
      return true;
    }
    return row[key] === condition;
  });
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    OUTREACH_SMTP_FROM_ADDRESS: 'outreach@example.test',
    OUTREACH_MAILBOX_DAILY_CAP: 30,
    OUTREACH_MAILBOX_WEEKLY_CAP: 120,
    OUTREACH_DOMAIN_HOURLY_CAP: 5,
    OUTREACH_SEND_WINDOW_START: '09:00',
    OUTREACH_SEND_WINDOW_END: '17:00',
    OUTREACH_SEND_WEEKDAYS: '1,2,3,4,5',
    OUTREACH_BOUNCE_WINDOW_DAYS: 7,
    OUTREACH_BOUNCE_MIN_SAMPLE: 20,
    OUTREACH_BOUNCE_RATE_HALT: 0.05,
    OUTREACH_COMPLAINT_MIN_SAMPLE: 100,
    OUTREACH_COMPLAINT_RATE_HALT: 0.003,
    ...overrides,
  } as AppConfig;
}

function controls(prisma: FakeControlsPrisma, overrides: Partial<AppConfig> = {}) {
  return new OutreachSendControls(prisma as unknown as PrismaService, config(overrides));
}

function errorCode(error: unknown): string {
  return (error as { response?: { error?: { code?: string } } }).response?.error?.code ?? '';
}

// 2026-11-11 是周三。柏林 11 月为 CET（UTC+1），7 月为 CEST（UTC+2）。
const WEDNESDAY_10_BERLIN = new Date('2026-11-11T09:00:00Z');
const WEDNESDAY_20_BERLIN = new Date('2026-11-11T19:00:00Z');
const SATURDAY = new Date('2026-11-14T10:00:00Z');

describe('recipientLocalTime（收件人当地时区，含 DST）', () => {
  it('按国家映射时区并解析当地星期/分钟', () => {
    const berlin = recipientLocalTime('DE', WEDNESDAY_10_BERLIN);
    expect(berlin).toMatchObject({ timezone: 'Europe/Berlin', weekday: 3, minutes: 600 });
    const newYork = recipientLocalTime('US', WEDNESDAY_10_BERLIN);
    expect(newYork).toMatchObject({ timezone: 'America/New_York', weekday: 3, minutes: 240 });
    const paris = recipientLocalTime('fr', WEDNESDAY_10_BERLIN);
    expect(paris).toMatchObject({ timezone: 'Europe/Paris' });
  });

  it('夏令时正确：柏林 7 月 06:30Z = 当地 08:30；纽约 7 月 13:30Z = 当地 09:30', () => {
    expect(recipientLocalTime('DE', new Date('2026-07-15T06:30:00Z')).minutes).toBe(8 * 60 + 30);
    expect(recipientLocalTime('US', new Date('2026-07-15T13:30:00Z')).minutes).toBe(9 * 60 + 30);
  });
});

describe('OutreachSendControls：发送窗口', () => {
  it('工作日上午（当地 10:00）放行', async () => {
    const state = await controls(new FakeControlsPrisma()).beginBatch(tenant, WEDNESDAY_10_BERLIN);
    expect(
      controls(new FakeControlsPrisma()).checkDraft(state, {
        recipientEmail: 'buyer@ziel.de',
        countryCode: 'DE',
        now: WEDNESDAY_10_BERLIN,
      }),
    ).toEqual({ action: 'SEND' });
  });

  it('负向：工作日晚间（当地 20:00）顺延 — OUTREACH_WINDOW_CLOSED', async () => {
    const instance = controls(new FakeControlsPrisma());
    const state = await instance.beginBatch(tenant, WEDNESDAY_20_BERLIN);
    expect(
      instance.checkDraft(state, {
        recipientEmail: 'buyer@ziel.de',
        countryCode: 'DE',
        now: WEDNESDAY_20_BERLIN,
      }),
    ).toEqual({ action: 'DEFER', code: 'OUTREACH_WINDOW_CLOSED' });
  });

  it('负向：周末一律顺延', async () => {
    const instance = controls(new FakeControlsPrisma());
    const state = await instance.beginBatch(tenant, SATURDAY);
    expect(
      instance.checkDraft(state, {
        recipientEmail: 'buyer@ziel.de',
        countryCode: 'DE',
        now: SATURDAY,
      }),
    ).toEqual({ action: 'DEFER', code: 'OUTREACH_WINDOW_CLOSED' });
  });

  it('窗口按收件人当地时区判定：柏林 20:00 时纽约 14:00 的收件人仍可发', async () => {
    const instance = controls(new FakeControlsPrisma());
    const state = await instance.beginBatch(tenant, WEDNESDAY_20_BERLIN);
    expect(
      instance.checkDraft(state, {
        recipientEmail: 'buyer@ziel.com',
        countryCode: 'US',
        now: WEDNESDAY_20_BERLIN,
      }),
    ).toEqual({ action: 'SEND' });
  });
});

describe('OutreachSendControls：信箱上限与收件域限速', () => {
  it('信箱当日已达上限（30）→ 顺延 — OUTREACH_MAILBOX_DAILY_CAP（临时额度，不烧草稿）', async () => {
    const prisma = new FakeControlsPrisma();
    const instance = controls(prisma);
    const state = await instance.beginBatch(tenant, WEDNESDAY_10_BERLIN);
    state.dailySent = 30;
    expect(
      instance.checkDraft(state, {
        recipientEmail: 'buyer@ziel.de',
        countryCode: 'DE',
        now: WEDNESDAY_10_BERLIN,
      }),
    ).toEqual({ action: 'DEFER', code: 'OUTREACH_MAILBOX_DAILY_CAP' });
  });

  it('信箱当周已达上限（120）→ 顺延 — OUTREACH_MAILBOX_WEEKLY_CAP', async () => {
    const instance = controls(new FakeControlsPrisma());
    const state = await instance.beginBatch(tenant, WEDNESDAY_10_BERLIN);
    state.weeklySent = 120;
    expect(
      instance.checkDraft(state, {
        recipientEmail: 'buyer@ziel.de',
        countryCode: 'DE',
        now: WEDNESDAY_10_BERLIN,
      }),
    ).toEqual({ action: 'DEFER', code: 'OUTREACH_MAILBOX_WEEKLY_CAP' });
  });

  it('同一收件域本小时已达 5 封 → 顺延 — OUTREACH_DOMAIN_RATE_LIMITED', async () => {
    const instance = controls(new FakeControlsPrisma());
    const state = await instance.beginBatch(tenant, WEDNESDAY_10_BERLIN);
    state.hourlyByDomain.set('ziel.de', 5);
    expect(
      instance.checkDraft(state, {
        recipientEmail: 'buyer@ziel.de',
        countryCode: 'DE',
        now: WEDNESDAY_10_BERLIN,
      }),
    ).toEqual({ action: 'DEFER', code: 'OUTREACH_DOMAIN_RATE_LIMITED' });
  });

  it('发送成功计数递进：同批后续封受同域限速约束', async () => {
    const instance = controls(new FakeControlsPrisma());
    const state = await instance.beginBatch(tenant, WEDNESDAY_10_BERLIN);
    for (let i = 0; i < 5; i += 1) {
      state.hourlyByDomain.set('ziel.de', i);
      expect(
        instance.checkDraft(state, {
          recipientEmail: `k${i}@ziel.de`,
          countryCode: 'DE',
          now: WEDNESDAY_10_BERLIN,
        }),
      ).toEqual({ action: 'SEND' });
      instance.recordSent(state, `k${i}@ziel.de`);
    }
    expect(
      instance.checkDraft(state, {
        recipientEmail: 'k5@ziel.de',
        countryCode: 'DE',
        now: WEDNESDAY_10_BERLIN,
      }),
    ).toEqual({ action: 'DEFER', code: 'OUTREACH_DOMAIN_RATE_LIMITED' });
    expect(state.dailySent).toBe(5);
    expect(state.weeklySent).toBe(5);
  });

  it('授权 caps 收紧 env 上限：beginBatch 传入更小值时按收紧值判定', async () => {
    const instance = controls(new FakeControlsPrisma());
    const state = await instance.beginBatch(tenant, WEDNESDAY_10_BERLIN, {
      perMailboxDaily: 1,
      perDomainHourly: 1,
    });
    expect(state.dailyCap).toBe(1);
    expect(state.domainHourlyCap).toBe(1);
    state.dailySent = 1;
    expect(
      instance.checkDraft(state, {
        recipientEmail: 'buyer@ziel.de',
        countryCode: 'DE',
        now: WEDNESDAY_10_BERLIN,
      }),
    ).toEqual({ action: 'DEFER', code: 'OUTREACH_MAILBOX_DAILY_CAP' });
    state.dailySent = 0;
    state.hourlyByDomain.set('ziel.de', 1);
    expect(
      instance.checkDraft(state, {
        recipientEmail: 'buyer@ziel.de',
        countryCode: 'DE',
        now: WEDNESDAY_10_BERLIN,
      }),
    ).toEqual({ action: 'DEFER', code: 'OUTREACH_DOMAIN_RATE_LIMITED' });
  });

  it('beginBatch 从台账恢复计数：当日已发 29 封时只剩 1 个名额', async () => {
    const prisma = new FakeControlsPrisma();
    for (let i = 0; i < 29; i += 1) {
      prisma.sends.push({
        workspaceId: WS,
        mailboxAddress: 'outreach@example.test',
        status: 'SENT',
        recipientEmail: `k${i}@other-${i}.de`,
        sentAt: new Date('2026-11-11T08:00:00Z'),
      });
    }
    const instance = controls(prisma);
    const state = await instance.beginBatch(tenant, WEDNESDAY_10_BERLIN);
    expect(state.dailySent).toBe(29);
    expect(
      instance.checkDraft(state, {
        recipientEmail: 'buyer@ziel.de',
        countryCode: 'DE',
        now: WEDNESDAY_10_BERLIN,
      }),
    ).toEqual({ action: 'SEND' });
  });
});

describe('OutreachSendControls：退信/投诉熔断（滚动 7 天）', () => {
  it('负向：退信率 ≥5%（样本 ≥20）→ 整批停发 — OUTREACH_MAILBOX_PAUSED', async () => {
    const prisma = new FakeControlsPrisma();
    const now = WEDNESDAY_10_BERLIN;
    for (let i = 0; i < 100; i += 1) {
      prisma.sends.push({
        workspaceId: WS,
        status: 'SENT',
        recipientEmail: `k${i}@ziel.de`,
        sentAt: new Date(now.getTime() - 86_400_000),
      });
    }
    for (let i = 0; i < 6; i += 1) {
      prisma.replies.push({
        workspaceId: WS,
        kind: 'BOUNCE',
        receivedAt: new Date(now.getTime() - 3_600_000),
      });
    }
    await expect(controls(prisma).assertHealthy(tenant, now)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_MAILBOX_PAUSED',
    );
  });

  it('样本不足（<20 封）时不触发退信熔断', async () => {
    const prisma = new FakeControlsPrisma();
    const now = WEDNESDAY_10_BERLIN;
    for (let i = 0; i < 10; i += 1) {
      prisma.sends.push({
        workspaceId: WS,
        status: 'SENT',
        recipientEmail: `k${i}@ziel.de`,
        sentAt: new Date(now.getTime() - 86_400_000),
      });
    }
    prisma.replies.push({
      workspaceId: WS,
      kind: 'BOUNCE',
      receivedAt: new Date(now.getTime() - 3_600_000),
    });
    await expect(controls(prisma).assertHealthy(tenant, now)).resolves.toBeUndefined();
  });

  it('负向：投诉率 ≥0.3%（样本 ≥100）→ 整批停发 — OUTREACH_DOMAIN_PAUSED', async () => {
    const prisma = new FakeControlsPrisma();
    const now = WEDNESDAY_10_BERLIN;
    for (let i = 0; i < 1_000; i += 1) {
      prisma.sends.push({
        workspaceId: WS,
        status: 'SENT',
        recipientEmail: `k${i}@ziel.de`,
        sentAt: new Date(now.getTime() - 86_400_000),
      });
    }
    for (let i = 0; i < 4; i += 1) {
      prisma.replies.push({
        workspaceId: WS,
        kind: 'COMPLAINT',
        receivedAt: new Date(now.getTime() - 3_600_000),
      });
    }
    await expect(controls(prisma).assertHealthy(tenant, now)).rejects.toSatisfy(
      (error) => errorCode(error) === 'OUTREACH_DOMAIN_PAUSED',
    );
  });

  it('窗口外的旧退信不计入滚动 7 天', async () => {
    const prisma = new FakeControlsPrisma();
    const now = WEDNESDAY_10_BERLIN;
    for (let i = 0; i < 100; i += 1) {
      prisma.sends.push({
        workspaceId: WS,
        status: 'SENT',
        recipientEmail: `k${i}@ziel.de`,
        sentAt: new Date(now.getTime() - 86_400_000),
      });
    }
    for (let i = 0; i < 10; i += 1) {
      prisma.replies.push({
        workspaceId: WS,
        kind: 'BOUNCE',
        receivedAt: new Date(now.getTime() - 8 * 86_400_000),
      });
    }
    await expect(controls(prisma).assertHealthy(tenant, now)).resolves.toBeUndefined();
  });
});

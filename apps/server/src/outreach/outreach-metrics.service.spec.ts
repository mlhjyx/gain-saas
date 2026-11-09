import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { AuditService } from '../shared/audit.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';
import {
  METRICS_DEFINITION_VERSION,
  OutreachMetricsService,
  wilsonInterval,
} from './outreach-metrics.service.js';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenant: OutreachTenant = { userId: 'user-a', workspaceId: WS, role: 'admin' };
const NOW = new Date('2026-11-11T09:00:00Z');

interface Row {
  [key: string]: unknown;
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      const obj = condition as Record<string, unknown>;
      if ('gte' in obj) return (row[key] as Date).getTime() >= (obj.gte as Date).getTime();
      if ('lt' in obj) return (row[key] as Date).getTime() < (obj.lt as Date).getTime();
      return true;
    }
    return row[key] === condition;
  });
}

class FakeMetricsPrisma {
  sends: Row[] = [];
  replies: Row[] = [];
  consents: Row[] = [];
  outcomes: Row[] = [];
  snapshots: Row[] = [];
  seq = 0;

  readonly outreachSend = {
    count: async ({ where }: { where: Row }) =>
      this.sends.filter((row) => matches(row, where)).length,
  };
  readonly outreachReply = {
    count: async ({ where }: { where: Row }) =>
      this.replies.filter((row) => matches(row, where)).length,
  };
  readonly outreachConsent = {
    count: async ({ where }: { where: Row }) =>
      this.consents.filter((row) => matches(row, where)).length,
  };
  readonly opportunityOutcome = {
    count: async ({ where }: { where: Row }) =>
      this.outcomes.filter((row) => matches(row, where)).length,
  };
  readonly outreachMetricSnapshot = {
    create: async ({ data }: { data: Row }) => {
      this.seq += 1;
      const row = { id: `snapshot-${this.seq}`, computedAt: new Date(), ...data };
      this.snapshots.push(row);
      return { ...row };
    },
  };
}

function build(prisma = new FakeMetricsPrisma()) {
  const audit = { record: vi.fn(async () => undefined) } as unknown as AuditService;
  return {
    prisma,
    service: new OutreachMetricsService(
      prisma as unknown as PrismaService,
      audit,
      { OUTREACH_COST_PER_EMAIL_MICROS: 37_000, OUTREACH_METRICS_WINDOW_DAYS: 28 } as AppConfig,
    ),
  };
}

const IN_WINDOW = new Date(NOW.getTime() - 3 * 86_400_000);

function seedWindow(prisma: FakeMetricsPrisma, options: { meetings?: number } = {}) {
  for (let index = 0; index < 100; index += 1) {
    prisma.sends.push({ workspaceId: WS, status: 'SENT', sentAt: IN_WINDOW });
  }
  for (let index = 0; index < 6; index += 1) {
    prisma.sends.push({
      workspaceId: WS,
      status: 'FAILED',
      bounceType: 'HARD',
      createdAt: IN_WINDOW,
    });
  }
  for (let index = 0; index < 2; index += 1) {
    prisma.replies.push({ workspaceId: WS, kind: 'BOUNCE', receivedAt: IN_WINDOW });
  }
  prisma.replies.push({ workspaceId: WS, kind: 'COMPLAINT', receivedAt: IN_WINDOW });
  for (let index = 0; index < 5; index += 1) {
    prisma.replies.push({ workspaceId: WS, kind: 'REPLY', receivedAt: IN_WINDOW });
  }
  for (let index = 0; index < 3; index += 1) {
    prisma.replies.push({ workspaceId: WS, kind: 'UNSUBSCRIBE', receivedAt: IN_WINDOW });
  }
  for (let index = 0; index < 4; index += 1) {
    prisma.consents.push({
      workspaceId: WS,
      channel: 'email',
      status: 'OPT_OUT',
      createdAt: IN_WINDOW,
    });
  }
  for (let index = 0; index < (options.meetings ?? 2); index += 1) {
    prisma.outcomes.push({
      workspaceId: WS,
      outcome: 'MEETING_BOOKED',
      occurredAt: IN_WINDOW,
    });
  }
}

describe('wilsonInterval（ch05 §5.3.7.4）', () => {
  it('25/100 的 95% 区间约 [0.177, 0.337]；0 分母返回 null', () => {
    const interval = wilsonInterval(25, 100)!;
    expect(interval.low).toBeGreaterThan(0.16);
    expect(interval.low).toBeLessThan(0.19);
    expect(interval.high).toBeGreaterThan(0.32);
    expect(interval.high).toBeLessThan(0.35);
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  it('小样本接近 0 时区间下界不为负、上界显著更大', () => {
    const interval = wilsonInterval(1, 20)!;
    expect(interval.low).toBeGreaterThanOrEqual(0);
    expect(interval.high).toBeGreaterThan(0.2);
  });
});

describe('OutreachMetricsService（P4-09 成本报表）', () => {
  it('窗口口径：退信=硬拒+DSN、投诉/回复/退订分母=SENT、成本=发送×单价', async () => {
    const { prisma, service } = build();
    seedWindow(prisma);
    const metrics = await service.computeWindow(
      tenant,
      new Date(NOW.getTime() - 28 * 86_400_000),
      NOW,
    );
    expect(metrics).toMatchObject({
      definitionVersion: METRICS_DEFINITION_VERSION,
      sent: 100,
      hardBounces: 6,
      dsnBounces: 2,
      complaints: 1,
      replies: 5,
      unsubscribes: 3,
      optOuts: 4,
      meetings: 2,
      costMicros: 100 * 37_000,
    });
    expect(metrics.rates.hardBounceRate.value).toBeCloseTo(8 / 106, 6);
    expect(metrics.rates.complaintRate.value).toBeCloseTo(0.01, 6);
    expect(metrics.rates.replyRate.value).toBeCloseTo(0.05, 6);
    expect(metrics.rates.optOutRate.value).toBeCloseTo(0.03, 6);
  });

  it('成本报表：每会议成本 = 成本/会议；无会议为 null；含口径限制说明', async () => {
    const { prisma, service } = build();
    seedWindow(prisma);
    const report = await service.costReport(tenant, 28, NOW);
    expect(report.costPerMeetingMicros).toBe(Math.round((100 * 37_000) / 2));
    expect(report.costPerSentMicros).toBe(37_000);
    expect(report.limitations.length).toBeGreaterThanOrEqual(3);

    const empty = build();
    const noMeetings = await empty.service.costReport(tenant, 28, NOW);
    expect(noMeetings.costPerMeetingMicros).toBeNull();
  });

  it('snapshot 落 7 行指标（含口径版本与成本），可重复写入形成周报序列', async () => {
    const { prisma, service } = build();
    seedWindow(prisma);
    const rows = await service.snapshot(tenant, { windowDays: 28, now: NOW });
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.definitionVersion === METRICS_DEFINITION_VERSION)).toBe(true);
    expect(rows.find((row) => row.metric === 'cost_per_meeting')).toMatchObject({
      numerator: 100 * 37_000,
      denominator: 2,
    });
    await service.snapshot(tenant, { windowDays: 28, now: NOW });
    expect(prisma.snapshots).toHaveLength(14);
  });
});

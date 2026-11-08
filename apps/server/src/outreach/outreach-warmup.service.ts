import { Injectable } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service.js';
import { OutreachMailboxService } from './outreach-mailbox.service.js';
import type { OutreachTenant } from './outreach-consent.service.js';

/**
 * warmup/seed 周检查清单（P4-12 后端支撑，ch05 §5.3.3.4）：
 * 每个发件域给出「最近 7 天是否做过种子测试 / 种子结果是否达标 / 信箱是否全部 ACTIVE / 今日与本周用量」，
 * 判定规则按计划写死：连续两周 Inbox ≥80%、Spam ≤10% 且每周有测试才算合格——这里输出周快照，
 * 「连续两周」的跨周判定由运营台读取多周快照完成（不在服务端做时序推断）。
 */
@Injectable()
export class OutreachWarmupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailboxes: OutreachMailboxService,
  ) {}

  async checklist(tenant: OutreachTenant, now: Date = new Date()) {
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const domains = await this.prisma.outreachDomain.findMany({
      where: { workspaceId: tenant.workspaceId },
      orderBy: { createdAt: 'asc' },
    });
    const items = [];
    for (const domain of domains) {
      const [mailboxRows, lastSeed] = await Promise.all([
        this.prisma.outreachMailbox.findMany({
          where: { workspaceId: tenant.workspaceId, domainId: domain.id },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.outreachSeedTest.findFirst({
          where: { domainId: domain.id, testedAt: { gte: weekAgo } },
          orderBy: { testedAt: 'desc' },
        }),
      ]);
      const mailboxes = [];
      for (const mailbox of mailboxRows) {
        const usage = await this.mailboxes.usage(mailbox.id, now);
        mailboxes.push({
          address: mailbox.address,
          state: mailbox.state,
          warmupStage: mailbox.warmupStage,
          dailyCap: mailbox.dailyCap,
          weeklyCap: mailbox.weeklyCap,
          dailySent: usage.dailySent,
          weeklySent: usage.weeklySent,
          dailyRemaining: Math.max(mailbox.dailyCap - usage.dailySent, 0),
          weeklyRemaining: Math.max(mailbox.weeklyCap - usage.weeklySent, 0),
        });
      }
      const seedFresh = Boolean(lastSeed);
      const inboxOk = lastSeed?.inboxPct == null ? null : lastSeed.inboxPct >= 80;
      const spamOk = lastSeed?.spamPct == null ? null : lastSeed.spamPct <= 10;
      const mailboxesOk =
        mailboxes.length > 0 && mailboxes.every((mailbox) => mailbox.state === 'ACTIVE');
      items.push({
        domain: domain.domain,
        domainState: domain.state,
        mailboxes,
        lastSeedTest: lastSeed
          ? {
              testedAt: lastSeed.testedAt,
              provider: lastSeed.provider,
              inboxPct: lastSeed.inboxPct,
              spamPct: lastSeed.spamPct,
              reportRef: lastSeed.reportRef,
            }
          : null,
        checks: {
          seedFresh,
          inboxOk,
          spamOk,
          mailboxesOk,
          ok:
            seedFresh &&
            inboxOk !== false &&
            spamOk !== false &&
            mailboxesOk,
        },
      });
    }
    return {
      generatedAt: now,
      windowDays: 7,
      thresholds: { inboxPctMin: 80, spamPctMax: 10 },
      domains: items,
    };
  }
}

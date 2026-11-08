import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import { OutreachHealthService } from './outreach-health.service.js';

/**
 * 熔断评估 worker（P4-08，OUTREACH_HEALTH_EVAL_ENABLED 默认 false）。
 * 遍历有发件信箱的 workspace 调用 evaluateWorkspace；也可由运营手动触发
 * POST /api/outreach/health/evaluate。评估只做「开闸」，关闸必须人工两步（recover→close）。
 */
@Injectable()
export class OutreachHealthWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly health: OutreachHealthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.OUTREACH_HEALTH_EVAL_ENABLED) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch(() => undefined);
    }, this.config.OUTREACH_HEALTH_EVAL_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(now: Date = new Date()): Promise<{ workspaces: number; opened: number }> {
    if (this.running) return { workspaces: 0, opened: 0 };
    this.running = true;
    try {
      const rows = await this.prisma.outreachMailbox.findMany({
        distinct: ['workspaceId'],
        select: { workspaceId: true },
      });
      let opened = 0;
      for (const row of rows) {
        const result = await this.health.evaluateWorkspace(row.workspaceId, now);
        opened += result.opened;
      }
      return { workspaces: rows.length, opened };
    } finally {
      this.running = false;
    }
  }
}

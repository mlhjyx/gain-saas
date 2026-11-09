import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import { OutreachMetricsService } from './outreach-metrics.service.js';

/**
 * 周指标快照 worker（P4-09，OUTREACH_METRICS_SNAPSHOT_ENABLED 默认 false）。
 * 遍历有发件信箱的 workspace 落 outreach_metric_snapshot；周报与成本报表只读快照/实时口径。
 */
@Injectable()
export class OutreachMetricsWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: OutreachMetricsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.OUTREACH_METRICS_SNAPSHOT_ENABLED) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch(() => undefined);
    }, this.config.OUTREACH_METRICS_SNAPSHOT_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(now: Date = new Date()): Promise<{ workspaces: number; snapshots: number }> {
    if (this.running) return { workspaces: 0, snapshots: 0 };
    this.running = true;
    try {
      const rows = await this.prisma.outreachMailbox.findMany({
        distinct: ['workspaceId'],
        select: { workspaceId: true },
      });
      let snapshots = 0;
      for (const row of rows) {
        const created = await this.metrics.snapshot(
          { userId: 'outreach-metrics-worker', workspaceId: row.workspaceId, role: 'admin' },
          { now },
        );
        snapshots += created.length;
      }
      return { workspaces: rows.length, snapshots };
    } finally {
      this.running = false;
    }
  }
}

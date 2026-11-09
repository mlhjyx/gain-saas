import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import { OutreachReconciliationService } from './outreach-reconciliation.service.js';

/**
 * 日对账 worker（P4-14，OUTREACH_RECONCILE_ENABLED 默认 false）：每天对账「昨天」的台账，
 * 遍历有发件信箱的 workspace；结果写审计（ok/差异数）。也可由运营手动 GET 端点触发。
 */
@Injectable()
export class OutreachReconciliationWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliation: OutreachReconciliationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.OUTREACH_RECONCILE_ENABLED) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch(() => undefined);
    }, this.config.OUTREACH_RECONCILE_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(now: Date = new Date()): Promise<{ workspaces: number; failing: number }> {
    if (this.running) return { workspaces: 0, failing: 0 };
    this.running = true;
    try {
      const rows = await this.prisma.outreachMailbox.findMany({
        distinct: ['workspaceId'],
        select: { workspaceId: true },
      });
      const yesterday = new Date(now.getTime() - 86_400_000);
      let failing = 0;
      for (const row of rows) {
        const result = await this.reconciliation.reconcile(
          { userId: 'outreach-reconcile-worker', workspaceId: row.workspaceId, role: 'admin' },
          yesterday,
        );
        if (!result.ok) failing += 1;
      }
      return { workspaces: rows.length, failing };
    } finally {
      this.running = false;
    }
  }
}

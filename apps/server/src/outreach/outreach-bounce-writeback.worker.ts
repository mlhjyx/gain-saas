import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { OutreachBounceWritebackService } from './outreach-bounce-writeback.service.js';

const INTERVAL_MS = 60_000;

/**
 * 退信回写 worker（缺口 3 P2）：与其它 outreach 定时器同模式（OnModuleInit + 防重入）。
 * 未配置 OUTREACH_ENGINE_SERVICE_TOKEN 时静默跳过——队列保留，配置后自动补发。
 */
@Injectable()
export class OutreachBounceWritebackWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly writeback: OutreachBounceWritebackService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.OUTREACH_ENGINE_SERVICE_TOKEN) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.writeback
        .drain()
        .catch(() => undefined)
        .finally(() => {
          this.running = false;
        });
    }, INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

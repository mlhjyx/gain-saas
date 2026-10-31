import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PLATFORM_SCHEDULES } from './contracts/r4-wire-contracts.js';
import { R4LeaseService } from './r4-lease.service.js';

/**
 * 租约心跳（P3c）。
 *
 * capability 只认「ACTIVE 且心跳 ≤30 秒」的租约，所以消费侧必须持续续期。
 * 默认关闭（`R4_LEASE_HEARTBEAT_ENABLED=true` 才启动），因为切换前线上仍由
 * GrowthOS 承担消费；启动本心跳会让 gain-saas 的库出现 ACTIVE 租约，但不会
 * 影响 GrowthOS（两边库不同）。
 */
export const LEASE_HEARTBEAT_INTERVAL_MS = 5_000;

@Injectable()
export class LeaseHeartbeatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('R4LeaseHeartbeat');
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly leases: R4LeaseService,
  ) {}

  onModuleInit(): void {
    if (!this.config.R4_LEASE_HEARTBEAT_ENABLED) return;
    void this.beat();
    this.timer = setInterval(() => void this.beat(), LEASE_HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
    this.logger.log(`租约心跳已启动（每 ${LEASE_HEARTBEAT_INTERVAL_MS} ms，4 个 schedule）`);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async beat(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    for (const scheduleId of PLATFORM_SCHEDULES) {
      try {
        await this.leases.renew(scheduleId, now);
      } catch (error) {
        this.logger.warn(`续期失败 ${scheduleId}: ${(error as Error).message}`);
      }
    }
  }
}

import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { AppConfig } from '../config/configuration.js';
import { APP_CONFIG } from '../shared/config.module.js';
import { WalletService } from './wallet.service.js';

/**
 * 僵尸预占（HELD 超时）定时巡检器：
 * 默认每 10 分钟扫描一次 status='HELD' AND expires_at <= now() 的过期预占单并自动退点。
 */
@Injectable()
export class WalletHoldSweeperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WalletHoldSweeperService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly wallet: WalletService,
  ) {}

  onModuleInit(): void {
    const enabled = this.config.WALLET_BILLING_ENABLED || this.config.WALLET_HOLD_SWEEP_ENABLED;
    if (!enabled || this.config.NODE_ENV === 'test') {
      return;
    }
    const intervalMs = this.config.WALLET_HOLD_SWEEP_INTERVAL_MS;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    this.logger.log(`充值钱包僵尸预占巡检已启动（间隔 ${intervalMs}ms）`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<{ scanned: number; released: number; failed: number } | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const result = await this.wallet.sweepExpiredHolds(50);
      if (result.released > 0 || result.failed > 0) {
        this.logger.log(`wallet hold sweep: ${JSON.stringify(result)}`);
      }
      return result;
    } catch (err) {
      this.logger.warn(
        `wallet hold sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      this.running = false;
    }
  }
}

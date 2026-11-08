import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';

/**
 * 触达发送总开关（M2 步 11-2 定义、11-3 执行器强制）：默认关闭。
 * 任何发送路径在真正调用 SMTP 前必须先过这里；关闭时 fail closed，绝不"尽力发送"。
 */
@Injectable()
export class OutreachSendGate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  enabled(): boolean {
    return this.config.OUTREACH_SEND_ENABLED === true;
  }

  assertEnabled(): void {
    if (!this.enabled()) {
      throw new ConflictException({
        error: {
          code: 'OUTREACH_SEND_DISABLED',
          message: '发送通道未开启，批次只能停留在待发送队列',
        },
      });
    }
  }
}

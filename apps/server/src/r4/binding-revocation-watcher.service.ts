import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import { bindingInstant } from './platform-facts.service.js';
import { REVOCATION_REASON_CODES, type RevocationReasonCode } from './revocation-issuer.service.js';
import { EGRESS_SCHEDULES, PlatformRevocationService } from './platform-revocation.service.js';

/**
 * 部署绑定的**显式撤销**监视器（P9）。
 *
 * 绑定文件每次签发/取事实都会重新读取，新增可选字段后即时生效：
 *  - `revokedAt`：ISO 字符串或 epoch 毫秒；存在即表示该绑定不再受信
 *  - `revokeReasonCode`：SECURITY_RESPONSE（默认）/ OPERATOR_HOLD / POLICY_DISABLED
 *  - `revokedBy` / `revokeNote`：写进审计
 *
 * 与「文件不可读 / JSON 损坏 / validUntil 自然过期」严格区分：那些只告警并停发新
 * Grant，不创建撤销请求。自然过期把一次运维疏忽变成不可逆围栏，代价不可接受。
 */

const CHECK_INTERVAL_MS = 15_000;

interface BindingRevocation {
  revokedAt?: unknown;
  revokeReasonCode?: unknown;
  revokedBy?: unknown;
  revokeNote?: unknown;
}

@Injectable()
export class BindingRevocationWatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('R4BindingRevocation');
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly revocations: PlatformRevocationService,
  ) {}

  onModuleInit(): void {
    if (!this.config.R4_REVOCATION_TRIGGER_ENABLED) return;
    if (this.config.PROCESS_ROLE !== 'web') return;
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.timer.unref();
    void this.check();
    this.logger.log(`部署绑定撤销监视已启动（每 ${CHECK_INTERVAL_MS} ms）`);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  async check(now = Date.now()): Promise<void> {
    if (this.stopped) return;
    const file = this.config.R4_DEPLOYMENT_BINDING_FILE;
    if (!file) return;
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      this.logger.warn(`部署绑定不可读（不等于撤销）: ${(error as Error).message}`);
      return;
    }
    let binding: BindingRevocation;
    try {
      binding = JSON.parse(raw) as BindingRevocation;
    } catch {
      this.logger.warn('部署绑定不是合法 JSON（不等于撤销）');
      return;
    }
    if (!binding || typeof binding !== 'object' || binding.revokedAt === undefined || binding.revokedAt === null) return;
    const revokedAt = bindingInstant(binding.revokedAt);
    if (!Number.isFinite(revokedAt)) {
      this.logger.warn('部署绑定的 revokedAt 非法（忽略）');
      return;
    }
    const reasonCode = (
      typeof binding.revokeReasonCode === 'string' ? binding.revokeReasonCode : 'SECURITY_RESPONSE'
    ) as RevocationReasonCode;
    if (!REVOCATION_REASON_CODES.includes(reasonCode)) {
      this.logger.warn(`部署绑定的 revokeReasonCode 非法（忽略）: ${String(binding.revokeReasonCode)}`);
      return;
    }
    const revokedBy = typeof binding.revokedBy === 'string' && binding.revokedBy.trim().length > 0
      ? binding.revokedBy.trim().slice(0, 200)
      : 'binding';
    const note = typeof binding.revokeNote === 'string' && binding.revokeNote.trim().length > 0
      ? binding.revokeNote.trim().slice(0, 300)
      : '部署绑定显式撤销';

    const states = await this.prisma.r4PlatformPolicyState.findMany({
      where: { scheduleId: { in: [...EGRESS_SCHEDULES] } },
    });
    for (const scheduleId of EGRESS_SCHEDULES) {
      const mode = states.find((state) => state.scheduleId === scheduleId)?.mode ?? 'ENABLED';
      if (mode !== 'ENABLED') continue;
      await this.revocations.create({
        scheduleId,
        reasonCode,
        source: 'BINDING_REVOKED',
        requestedBy: `binding:${revokedBy}`,
        note,
        // 同一份绑定的同一次撤销只产生一个请求；重复轮询幂等返回。
        dedupeKey: `binding-revoked:${scheduleId}:${new Date(revokedAt).toISOString()}`,
      });
    }
  }
}

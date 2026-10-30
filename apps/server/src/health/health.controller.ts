import { Controller, Get, Inject } from '@nestjs/common';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';

/**
 * /health/live:进程活着;/health/ready:引擎可达 + 自有库可用(如实降级,不美化)。
 * 运营域引擎库探针状态由 ops 模块另行暴露。
 */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' as const, time: new Date().toISOString() };
  }

  @Get('ready')
  async ready() {
    const [db] = await Promise.all([this.prisma.health()]);
    let engine: { ok: boolean; latencyMs: number; error?: string };
    const t0 = Date.now();
    try {
      // 引擎 = 全局前缀 /api + URI 版本化(默认 v1)→ 健康端点:/api/v1/health/live
      const res = await fetch(new URL('/api/v1/health/live', this.config.ENGINE_ORIGIN), { signal: AbortSignal.timeout(3000) });
      engine = { ok: res.ok, latencyMs: Date.now() - t0, error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      engine = { ok: false, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
    }
    const ok = db.ok && engine.ok;
    return {
      status: ok ? ('ok' as const) : ('degraded' as const),
      checks: { db, engine },
      capabilities: { event_consumer: this.config.EVENT_CONSUMER_ENABLED },
    };
  }
}

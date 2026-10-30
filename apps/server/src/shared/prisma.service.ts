import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * SaaS 自有库连接。M0 采取惰性连接:进程可在库暂不可用时先起(健康检查如实降级),
 * 首次真正查询时才建连;M1 起 onModuleInit 主动 connect。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async health(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const t0 = Date.now();
    try {
      await this.$queryRaw`SELECT 1`;
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect().catch((err) => this.logger.warn(`断开数据库连接失败: ${String(err)}`));
  }
}

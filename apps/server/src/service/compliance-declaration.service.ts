import { Injectable } from '@nestjs/common';
import { PrismaService } from '../shared/prisma.service.js';

/**
 * 租户数据处理声明的**只读历史**（2026-11-04 产品负责人决定：取消租户声明）。
 *
 * - 不再提供声明/更新入口：合法依据由平台统一注入（见 bff/routes.ts 的 PLATFORM_LAWFUL_BASIS）；
 * - 历史声明（每个 workspace 每次声明一版）原样留存，本服务只供只读回看与审计；
 * - 引擎请求级合同未变，将来若恢复租户声明模式可在此基础上重建写入路径。
 */
@Injectable()
export class ComplianceDeclarationService {
  constructor(private readonly prisma: PrismaService) {}

  /** 该工作空间留存的历史声明（最新在前，最多 20 版）。 */
  async history(workspaceId: string) {
    return this.prisma.workspaceComplianceDeclaration.findMany({
      where: { workspaceId },
      orderBy: { version: 'desc' },
      take: 20,
    });
  }
}

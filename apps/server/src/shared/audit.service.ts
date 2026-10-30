import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service.js';

/**
 * 控制面审计(A7):注册/登录/登出/邀请/角色变更/移除/工作空间创建与切换全量留痕。
 * SaaS 自查库,不依赖引擎。
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: {
    realm: 'tenant' | 'ops' | 'service';
    actorId: string;
    action: string;
    target?: string;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.auditLog
      .create({
        data: {
          realm: input.realm,
          actorId: input.actorId,
          action: input.action,
          target: input.target,
          detail: input.detail as Prisma.InputJsonValue | undefined,
        },
      })
      .catch(() => undefined); // 审计失败不阻断业务,但生产应告警(M2 接入告警通道)
  }
}

import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service.js';

/**
 * 幂等键（P5b-05）：BFF 变更请求可携带 `Idempotency-Key`，同一（租户, 路由, 键）
 * 只真正执行一次；重放返回首次响应。同键不同请求体返回 409（复用键属误用）。
 *
 * 记录保留 24h：到期前重放仍返回原响应，到期后由维护任务清理（当前按需惰性清理，
 * 行数规模 = 每日变更请求量，短期无压力）。
 */

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/u;

export interface IdempotencyRecordShape {
  expiresAt: Date;
  requestHash: string;
  responseBody: Prisma.JsonValue;
  responseStatus: number;
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  /** sha256(规范化 JSON 请求体)；GET 无体传 null。 */
  requestHash(body: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(body ?? null))
      .digest('hex');
  }

  async lookup(
    workspaceId: string,
    scope: string,
    key: string,
  ): Promise<IdempotencyRecordShape | null> {
    const row = await this.prisma.idempotencyRecord.findUnique({
      where: { workspaceId_scope_key: { workspaceId, scope, key } },
      select: {
        requestHash: true,
        responseStatus: true,
        responseBody: true,
        expiresAt: true,
      },
    });
    return row;
  }

  /**
   * 记录首次响应；并发同键（唯一约束冲突）时返回已存在行，由调用方按重放处理。
   */
  async save(input: {
    body: unknown;
    key: string;
    requestHash: string;
    responseStatus: number;
    scope: string;
    workspaceId: string;
  }): Promise<IdempotencyRecordShape> {
    const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS);
    try {
      const row = await this.prisma.idempotencyRecord.create({
        data: {
          workspaceId: input.workspaceId,
          scope: input.scope,
          key: input.key,
          requestHash: input.requestHash,
          responseStatus: input.responseStatus,
          responseBody: (input.body ?? null) as Prisma.InputJsonValue,
          expiresAt,
        },
        select: {
          requestHash: true,
          responseStatus: true,
          responseBody: true,
          expiresAt: true,
        },
      });
      return row;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.lookup(
          input.workspaceId,
          input.scope,
          input.key,
        );
        if (existing) return existing;
      }
      throw error;
    }
  }
}

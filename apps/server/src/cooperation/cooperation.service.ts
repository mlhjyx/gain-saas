import { createHmac } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CooperationIntentStatus, Prisma } from '@prisma/client';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { AuditService } from '../shared/audit.service.js';
import { AuthThrottleService, THROTTLE_POLICIES } from '../shared/auth-throttle.service.js';
import { PrismaService } from '../shared/prisma.service.js';
import { parseCooperationIntentPayload } from './cooperation-payload.js';
import { cleanText, ContentRejectedError } from './cooperation-sanitizer.js';

export const COOPERATION_STATUSES = ['NEW', 'CONTACTED', 'CLOSED'] as const;
const STATUS_SET = new Set<string>(COOPERATION_STATUSES);

export interface SubmitContext {
  /** 客户端 IP（用于限流与取证；只落 HMAC 摘要，不存明文）。 */
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * 官网合作意向：公开提交 + 运营台读取/跟进。
 * - 限流：同一 IP 短窗 + 日窗，同一邮箱日窗；命中返回 429。
 * - 清洗：parseCooperationIntentPayload 拒绝 HTML/脚本载荷（400 INVALID_CONTENT）。
 * - 存储：本仓 cooperation_intent；不创建引擎 Company/Lead 主状态。
 */
@Injectable()
export class CooperationIntentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly throttle: AuthThrottleService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async submit(body: unknown, context: SubmitContext): Promise<{ id: string; createdAt: Date }> {
    const ip = context.ip ?? 'unknown';
    const ipDigest = this.hashValue('ip', ip);
    // 同一维度下不同策略必须用不同键：共用键会让两次 hit 把短窗配额翻倍消耗。
    const ipShortKey = `coop-intent:ip:short:${ipDigest}`;
    const ipDailyKey = `coop-intent:ip:daily:${ipDigest}`;

    // 先计数再校验：恶意/畸形请求同样消耗配额，避免被当作无限验证器。
    await this.throttle.check(ipShortKey, THROTTLE_POLICIES.cooperationIntentIp);
    await this.throttle.check(ipDailyKey, THROTTLE_POLICIES.cooperationIntentIpDaily);
    await this.throttle.hit(ipShortKey, THROTTLE_POLICIES.cooperationIntentIp);
    await this.throttle.hit(ipDailyKey, THROTTLE_POLICIES.cooperationIntentIpDaily);

    let payload;
    try {
      payload = parseCooperationIntentPayload(body);
    } catch (error) {
      if (error instanceof ContentRejectedError) {
        throw new BadRequestException({
          error: {
            code: 'INVALID_CONTENT',
            message: '提交内容不合法，请检查后重试',
            details: [{ field: error.field, reason: error.reason }],
          },
        });
      }
      throw new BadRequestException({
        error: { code: 'VALIDATION_FAILED', message: '请求体必须是 JSON 对象' },
      });
    }

    const emailKey = `coop-intent:email:daily:${this.hashValue('email', payload.email)}`;
    await this.throttle.check(emailKey, THROTTLE_POLICIES.cooperationIntentEmailDaily);
    await this.throttle.hit(emailKey, THROTTLE_POLICIES.cooperationIntentEmailDaily);

    const userAgent = (context.userAgent ?? '').slice(0, 300) || null;
    const row = await this.prisma.cooperationIntent.create({
      data: {
        name: payload.name,
        email: payload.email,
        company: payload.company,
        contact: payload.contact,
        industry: payload.industry,
        region: payload.region,
        message: payload.message,
        source: 'website',
        ipHash: ipDigest,
        userAgent,
      },
      select: { id: true, createdAt: true },
    });
    return row;
  }

  async list(query: { status?: string; limit?: number; offset?: number }) {
    const status = query.status && STATUS_SET.has(query.status) ? (query.status as CooperationIntentStatus) : undefined;
    if (query.status && !status) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_FAILED', message: 'status 只能是 NEW / CONTACTED / CLOSED' },
      });
    }
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);
    const where: Prisma.CooperationIntentWhereInput = status ? { status } : {};

    const [intents, total, grouped] = await Promise.all([
      this.prisma.cooperationIntent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.cooperationIntent.count({ where }),
      this.prisma.cooperationIntent.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    const counts: Record<string, number> = { NEW: 0, CONTACTED: 0, CLOSED: 0 };
    for (const group of grouped) counts[group.status] = group._count._all;
    return { intents, total, counts, limit, offset };
  }

  async update(input: {
    id: string;
    status?: unknown;
    note?: unknown;
    actorId: string;
  }): Promise<{ id: string }> {
    const current = await this.prisma.cooperationIntent.findUnique({ where: { id: input.id } });
    if (!current) {
      throw new NotFoundException({ error: { code: 'NOT_FOUND', message: '合作意向不存在' } });
    }
    const data: Prisma.CooperationIntentUpdateInput = {};
    if (input.status !== undefined) {
      if (typeof input.status !== 'string' || !STATUS_SET.has(input.status)) {
        throw new BadRequestException({
          error: { code: 'VALIDATION_FAILED', message: 'status 只能是 NEW / CONTACTED / CLOSED' },
        });
      }
      data.status = input.status as CooperationIntentStatus;
      if (input.status === 'NEW') {
        data.handledAt = null;
        data.handledBy = null;
      } else {
        data.handledAt = new Date();
        data.handledBy = input.actorId;
      }
    }
    if (input.note !== undefined) {
      try {
        data.note = cleanText('note', input.note, { max: 1000, multiline: true });
      } catch (error) {
        if (error instanceof ContentRejectedError) {
          throw new BadRequestException({
            error: {
              code: 'INVALID_CONTENT',
              message: '备注包含不允许的内容',
              details: [{ field: 'note', reason: error.reason }],
            },
          });
        }
        throw error;
      }
    }
    if (Object.keys(data).length === 0) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_FAILED', message: '至少提供 status 或 note' },
      });
    }

    await this.prisma.cooperationIntent.update({ where: { id: input.id }, data });
    await this.audit.record({
      realm: 'ops',
      actorId: input.actorId,
      action: 'cooperation_intent.update',
      target: input.id,
      detail: {
        status: typeof input.status === 'string' ? input.status : undefined,
        noteChanged: input.note !== undefined,
      },
    });
    return { id: input.id };
  }

  /** 限流键与 ip_hash 都只用 HMAC 摘要：库内不出现明文 IP / 邮箱键。 */
  private hashValue(kind: 'ip' | 'email', value: string): string {
    return createHmac('sha256', this.config.SESSION_SECRET).update(`${kind}:${value}`).digest('hex');
  }
}

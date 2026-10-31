import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import { AuditService } from '../shared/audit.service.js';
import {
  REVOCATION_REASON_CODES,
  type RevocationReasonCode,
} from './revocation-issuer.service.js';

/**
 * 平台撤销的**逻辑请求**（P9 自动触发）。
 *
 * 语义取自 2026-09-13 已批准恢复规格：
 *  - 一个请求对应一次「关闭某个 schedule」的意图，fence_sequence 在创建时分配、此后不变；
 *  - 请求可以有多次追加式尝试（attempt）；ACK 只推进本请求；
 *  - 缺 ACK 一律记 delivery_unknown，保持 PENDING 原字节重试，绝不当作未提交；
 *  - 同一 schedule 同时只允许一个未结请求（数据库部分唯一索引 + 本层幂等返回）。
 *
 * 这里只做持久状态与审计；签名、投递与 ACK 验签在投递服务里。
 */

/** 有 egress 的三个 schedule；patents-cache-refresh 按设计无 egress，不能撤销。 */
export const EGRESS_SCHEDULES = ['acq-sweep', 'intent-sweep', 'sanctions-refresh'] as const;
export type EgressScheduleId = (typeof EGRESS_SCHEDULES)[number];

export const REVOCATION_SOURCES = ['POLICY_STATE', 'BINDING_REVOKED', 'OPERATOR'] as const;
export type RevocationSource = (typeof REVOCATION_SOURCES)[number];

/** 未结请求：新触发幂等返回其中之一，Grant 签发也据此拒绝。 */
export const ACTIVE_REQUEST_STATES = [
  'PENDING_CONFIRMATION',
  'PENDING',
  'BLOCKED',
  'STORED_STATE_CONFLICT',
] as const;

/**
 * 计入 capability 积压的状态（未拿到真实 ACK 的投递义务）。
 * 刻意排除 PENDING_CONFIRMATION：那是等待人工确认的刻意门，不应当让整个平台 not ready；
 * 也排除 NO_LIVE_TARGET：没有 live Grant 就没有可出网的 authority，属已解决的终态。
 */
export const BACKLOG_REQUEST_STATES = ['PENDING', 'BLOCKED', 'STORED_STATE_CONFLICT'] as const;

export const TERMINAL_REQUEST_STATES = [
  'ACKED',
  'NO_LIVE_TARGET',
  'BLOCKED',
  'STORED_STATE_CONFLICT',
  'CANCELLED',
] as const;

/** 允许操作员取消的状态：从未投递，或已确定未提交。PENDING 可能已提交，绝不可取消。 */
export const CANCELLABLE_REQUEST_STATES = [
  'PENDING_CONFIRMATION',
  'BLOCKED',
  'STORED_STATE_CONFLICT',
] as const;

export const ATTEMPT_OUTCOMES = [
  'ACKED',
  'SCOPE_MISMATCH',
  'EXPIRED_UNCOMMITTED',
  'INVALID',
  'REUSED',
  'SEQUENCE_CONFLICT',
] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

export interface CreateRevocationInput {
  scheduleId: string;
  reasonCode: RevocationReasonCode;
  source: RevocationSource;
  requestedBy: string;
  note?: string;
  dedupeKey?: string;
}

export interface AckFacts {
  receiptId: string;
  generation: string;
  committedAt: number;
  inFlightAttempts: string;
  ackSha256: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_NOTE = 300;

function bounded(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max)
    throw new Error('R4_REVOCATION_TEXT_INVALID');
  return value;
}

export class RevocationRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

@Injectable()
export class PlatformRevocationService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 创建（或幂等返回）一个逻辑撤销请求；序列号在这里一次分配。 */
  async create(input: CreateRevocationInput) {
    const scheduleId = this.assertEgressSchedule(input.scheduleId);
    if (!REVOCATION_REASON_CODES.includes(input.reasonCode))
      throw new RevocationRequestError('R4_REVOCATION_REASON_INVALID', `未知 reason_code: ${input.reasonCode}`);
    if (!REVOCATION_SOURCES.includes(input.source))
      throw new RevocationRequestError('R4_REVOCATION_SOURCE_INVALID', `未知来源: ${input.source}`);
    const requestedBy = bounded(input.requestedBy, 200);
    const note = input.note === undefined || input.note.trim().length === 0
      ? undefined
      : bounded(input.note, MAX_NOTE);
    const dedupeKey = input.dedupeKey === undefined ? undefined : bounded(input.dedupeKey, 300);

    if (dedupeKey) {
      const existing = await this.prisma.r4RevocationRequest.findUnique({ where: { dedupeKey } });
      if (existing) return existing;
    }
    const active = await this.prisma.r4RevocationRequest.findFirst({
      where: { scheduleId, state: { in: [...ACTIVE_REQUEST_STATES] } },
      orderBy: { createdAt: 'desc' },
    });
    if (active) {
      // 把本次触发的 dedupeKey 记到已存在的未结请求上（若空闲），
      // 否则该来源在请求终态后会再次触发一次重复请求。
      if (dedupeKey)
        await this.prisma.r4RevocationRequest.updateMany({
          where: { id: active.id, dedupeKey: null }, data: { dedupeKey },
        }).catch(() => undefined);
      await this.audit.record({
        realm: 'service', actorId: requestedBy, action: 'r4.revocation.duplicate',
        target: scheduleId, detail: { requestId: active.id, state: active.state, source: input.source },
      });
      return active;
    }

    const fenceSequence = await this.nextSequence(scheduleId);
    const state =
      input.source === 'OPERATOR' || this.config.R4_REVOCATION_AUTO_CONFIRM
        ? 'PENDING'
        : 'PENDING_CONFIRMATION';
    try {
      const created = await this.prisma.r4RevocationRequest.create({
        data: {
          scheduleId,
          reasonCode: input.reasonCode,
          source: input.source,
          requestedBy,
          note,
          dedupeKey,
          state,
          fenceSequence,
        },
      });
      await this.audit.record({
        realm: 'service', actorId: requestedBy, action: 'r4.revocation.requested',
        target: scheduleId,
        detail: {
          requestId: created.id, reasonCode: input.reasonCode, source: input.source,
          fenceSequence: String(fenceSequence), state,
        },
      });
      return created;
    } catch (error) {
      // 并发入口：部分唯一索引或 dedupe_key 撞车时返回已存在的赢家。
      if ((error as { code?: string }).code === 'P2002') {
        const winner = dedupeKey
          ? await this.prisma.r4RevocationRequest.findUnique({ where: { dedupeKey } })
          : await this.prisma.r4RevocationRequest.findFirst({
              where: { scheduleId, state: { in: [...ACTIVE_REQUEST_STATES] } },
              orderBy: { createdAt: 'desc' },
            });
        if (winner) return winner;
      }
      throw error;
    }
  }

  /** 操作员确认自动来源的请求（PENDING_CONFIRMATION → PENDING）。 */
  async confirm(id: string, actor: string) {
    if (!UUID.test(id)) throw new RevocationRequestError('R4_REVOCATION_REQUEST_NOT_FOUND', '请求不存在');
    const confirmedBy = bounded(actor, 200);
    const updated = await this.prisma.r4RevocationRequest.updateMany({
      where: { id, state: 'PENDING_CONFIRMATION' },
      data: { state: 'PENDING', confirmedBy, confirmedAt: new Date(), nextAttemptAt: null },
    });
    const request = await this.prisma.r4RevocationRequest.findUnique({ where: { id } });
    if (!request) throw new RevocationRequestError('R4_REVOCATION_REQUEST_NOT_FOUND', '请求不存在');
    if (updated.count !== 1 && request.state !== 'PENDING')
      throw new RevocationRequestError(
        'R4_REVOCATION_REQUEST_NOT_CONFIRMABLE', `当前状态 ${request.state} 不能确认`,
      );
    if (updated.count === 1) {
      await this.audit.record({
        realm: 'ops', actorId: confirmedBy, action: 'r4.revocation.confirmed',
        target: request.scheduleId, detail: { requestId: request.id, fenceSequence: String(request.fenceSequence) },
      });
    }
    return request;
  }

  /**
   * 操作员取消一个从未投递或已确定未提交的请求（BLOCKED / STORED_STATE_CONFLICT /
   * PENDING_CONFIRMATION）。PENDING 可能已经提交，取消它等于把未知当未提交，禁止。
   */
  async cancel(id: string, actor: string, reason: string) {
    if (!UUID.test(id)) throw new RevocationRequestError('R4_REVOCATION_REQUEST_NOT_FOUND', '请求不存在');
    const cancelledBy = bounded(actor, 200);
    const note = bounded(reason, MAX_NOTE);
    const updated = await this.prisma.r4RevocationRequest.updateMany({
      where: { id, state: { in: [...CANCELLABLE_REQUEST_STATES] } },
      data: { state: 'CANCELLED', nextAttemptAt: null, lastError: `CANCELLED: ${note}`.slice(0, 300) },
    });
    const request = await this.prisma.r4RevocationRequest.findUnique({ where: { id } });
    if (!request) throw new RevocationRequestError('R4_REVOCATION_REQUEST_NOT_FOUND', '请求不存在');
    if (updated.count !== 1)
      throw new RevocationRequestError(
        'R4_REVOCATION_REQUEST_NOT_CANCELLABLE', `当前状态 ${request.state} 不能取消`,
      );
    await this.audit.record({
      realm: 'ops', actorId: cancelledBy, action: 'r4.revocation.cancelled',
      target: request.scheduleId, detail: { requestId: id, reason: note },
    });
    return request;
  }

  async list(limit = 100) {
    return this.prisma.r4RevocationRequest.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      include: { attempts: { orderBy: { ordinal: 'desc' }, take: 3 } },
    });
  }

  async get(id: string) {
    if (!UUID.test(id)) throw new RevocationRequestError('R4_REVOCATION_REQUEST_NOT_FOUND', '请求不存在');
    const request = await this.prisma.r4RevocationRequest.findUnique({
      where: { id }, include: { attempts: { orderBy: { ordinal: 'asc' } } },
    });
    if (!request) throw new RevocationRequestError('R4_REVOCATION_REQUEST_NOT_FOUND', '请求不存在');
    return request;
  }

  async policyStates() {
    return this.prisma.r4PlatformPolicyState.findMany({ orderBy: { scheduleId: 'asc' } });
  }

  /** 记录确定性未命中（target 未 admitted）；请求保持 PENDING，下一轮换/重试 target。 */
  async markAttemptUntargeted(
    requestId: string, attemptId: string, outcome: AttemptOutcome,
    httpStatus: number, errorCode: string, nextAttemptAt: Date | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.r4RevocationAttempt.update({
        where: { id: attemptId },
        data: { outcome, httpStatus, errorCode: errorCode.slice(0, 120) },
      });
      await tx.r4RevocationRequest.updateMany({
        where: { id: requestId, state: 'PENDING' },
        data: {
          nextAttemptAt, lastError: errorCode.slice(0, 300),
          attemptCount: { increment: 1 },
        },
      });
    });
  }

  /** 投递结果未知（网络/超时/503）：保持 PENDING，原字节重试，不宣布未提交。 */
  async noteTransientFailure(
    requestId: string, errorCode: string, nextAttemptAt: Date,
  ): Promise<void> {
    await this.prisma.r4RevocationRequest.updateMany({
      where: { id: requestId, state: 'PENDING' },
      data: {
        deliveryUnknown: true, lastError: errorCode.slice(0, 300),
        nextAttemptAt, attemptCount: { increment: 1 },
      },
    });
  }

  /** ACK 验签通过后原子落库：请求 ACKED + 尝试 ACKED 必须同事务。 */
  async markAcked(requestId: string, attemptId: string, facts: AckFacts): Promise<void> {
    const { receiptId, generation, committedAt, inFlightAttempts, ackSha256 } = facts;
    if (!UUID.test(receiptId) || !/^(0|[1-9][0-9]*)$/.test(generation) || generation === '0'
      || !Number.isSafeInteger(committedAt) || committedAt < 0
      || !/^(0|[1-9][0-9]*)$/.test(inFlightAttempts) || !/^[0-9a-f]{64}$/.test(ackSha256))
      throw new RevocationRequestError('R4_REVOCATION_ACK_FACTS_INVALID', 'ACK 事实不合法');
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.r4RevocationRequest.updateMany({
        where: { id: requestId, state: 'PENDING' },
        data: {
          state: 'ACKED', deliveryUnknown: false, nextAttemptAt: null, lastError: null,
          ackReceiptId: receiptId, ackGeneration: BigInt(generation),
          ackCommittedAt: new Date(committedAt * 1000),
          ackInFlightAttempts: BigInt(inFlightAttempts), ackSha256,
        },
      });
      if (updated.count !== 1) throw new Error('R4_REVOCATION_REQUEST_STATE_CHANGED');
      await tx.r4RevocationAttempt.update({
        where: { id: attemptId },
        data: { outcome: 'ACKED', httpStatus: 200, errorCode: null, ackSha256 },
      });
    });
    const request = await this.prisma.r4RevocationRequest.findUnique({ where: { id: requestId } });
    if (request) {
      await this.audit.record({
        realm: 'service', actorId: 'r4-revocation-delivery', action: 'r4.revocation.acked',
        target: request.scheduleId,
        detail: {
          requestId, receiptId, generation, committedAt, inFlightAttempts,
          fenceSequence: String(request.fenceSequence),
        },
      });
    }
  }

  /** 终态：BLOCKED（配置/密钥/复用缺陷）或 STORED_STATE_CONFLICT（需要人工核查）。 */
  async setTerminal(requestId: string, state: 'BLOCKED' | 'STORED_STATE_CONFLICT', lastError: string) {
    const updated = await this.prisma.r4RevocationRequest.updateMany({
      where: { id: requestId, state: 'PENDING' },
      data: { state, lastError: lastError.slice(0, 300), nextAttemptAt: null },
    });
    if (updated.count === 1) {
      const request = await this.prisma.r4RevocationRequest.findUnique({ where: { id: requestId } });
      await this.audit.record({
        realm: 'service', actorId: 'r4-revocation-delivery',
        action: state === 'BLOCKED' ? 'r4.revocation.blocked' : 'r4.revocation.stored_state_conflict',
        target: request?.scheduleId ?? requestId, detail: { requestId, lastError: lastError.slice(0, 300) },
      });
    }
  }

  /** 没有 live Grant：没有可出网的 authority，记已解决的终态（不挂起、不阻塞 capability）。 */
  async finishNoLiveTarget(requestId: string) {
    const updated = await this.prisma.r4RevocationRequest.updateMany({
      where: { id: requestId, state: 'PENDING' },
      data: { state: 'NO_LIVE_TARGET', nextAttemptAt: null, lastError: null },
    });
    if (updated.count === 1) {
      const request = await this.prisma.r4RevocationRequest.findUnique({ where: { id: requestId } });
      await this.audit.record({
        realm: 'service', actorId: 'r4-revocation-delivery', action: 'r4.revocation.no_live_target',
        target: request?.scheduleId ?? requestId, detail: { requestId },
      });
    }
  }

  private assertEgressSchedule(value: string): EgressScheduleId {
    if (!EGRESS_SCHEDULES.includes(value as EgressScheduleId))
      throw new RevocationRequestError(
        'R4_REVOCATION_SCHEDULE_INVALID',
        `schedule 没有 egress，不能撤销: ${value}`,
      );
    return value as EgressScheduleId;
  }

  /**
   * 持久序列号：每 schedule 一个计数器，请求创建时取走一个号。
   * 未决请求同样占用自己的号，避免新请求与未知结果撞号（已批准规格 §6.3）。
   */
  private async nextSequence(scheduleId: EgressScheduleId): Promise<bigint> {
    const rows = await this.prisma.$queryRaw<Array<{ next_value: bigint }>>(Prisma.sql`
      INSERT INTO "r4_revocation_sequence" ("schedule_id", "next_value")
      VALUES (${scheduleId}, 2)
      ON CONFLICT ("schedule_id")
      DO UPDATE SET "next_value" = "r4_revocation_sequence"."next_value" + 1
      RETURNING "next_value" - 1 AS "next_value"
    `);
    const value = rows[0]?.next_value;
    if (typeof value !== 'bigint' || value <= 0n)
      throw new RevocationRequestError('R4_REVOCATION_SEQUENCE_UNAVAILABLE', '无法分配 fence_sequence');
    return value;
  }
}

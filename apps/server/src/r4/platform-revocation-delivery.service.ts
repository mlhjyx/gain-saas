import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { decodeJwt } from 'jose';
import type { R4PlatformGrant, R4RevocationAttempt, R4RevocationRequest } from '@prisma/client';
import { APP_CONFIG } from '../shared/config.module.js';
import type { AppConfig } from '../config/configuration.js';
import { PrismaService } from '../shared/prisma.service.js';
import { RevocationClient, RevocationDeliveryError } from './revocation-client.service.js';
import { RevocationIssuer, type RevocationReasonCode } from './revocation-issuer.service.js';
import { FenceAckVerifier } from './fence-ack-verifier.service.js';
import { PlatformPolicyStateService } from './platform-policy-state.service.js';
import { PlatformRevocationService, type AttemptOutcome } from './platform-revocation.service.js';
import type { PlatformScheduleId } from './contracts/r4-wire-contracts.js';

/**
 * 撤销请求的后台投递循环（P9）。
 *
 * 规则（2026-09-13 已批准恢复规格）：
 *  - 先原字节重放最老的未决尝试；同一命令在后端要么提交并重放 ACK，要么被确定性拒绝；
 *  - 缺 ACK（网络/超时/503/泛 409/ACK 验签失败）只记 delivery_unknown，绝不当未提交；
 *  - 确定性非提交（SCOPE_MISMATCH / EXPIRED / 已提交的 replay）才允许追加 successor；
 *  - SEQUENCE_CONFLICT 不自动 +1，停在 STORED_STATE_CONFLICT 等人工核查。
 *
 * 该循环只在 R4_REVOCATION_TRIGGER_ENABLED=true 时启动（默认关闭）。
 */

const TICK_MS = 5_000;
const BATCH = 8;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
/** SCOPE_MISMATCH 后重试同一 live Grant 的间隔：Grant 可能在首次检查后才被准入。 */
const SCOPE_RETRY_MS = 15_000;

type RequestWithAttempts = R4RevocationRequest & { attempts: R4RevocationAttempt[] };

@Injectable()
export class PlatformRevocationDeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('R4RevocationDelivery');
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly revocations: PlatformRevocationService,
    private readonly policy: PlatformPolicyStateService,
    private readonly issuer: RevocationIssuer,
    private readonly client: RevocationClient,
    private readonly verifier: FenceAckVerifier,
  ) {}

  onModuleInit(): void {
    if (!this.config.R4_REVOCATION_TRIGGER_ENABLED) return;
    if (this.config.PROCESS_ROLE !== 'web') return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
    this.logger.log(`撤销投递循环已启动（每 ${TICK_MS} ms，自动确认=${this.config.R4_REVOCATION_AUTO_CONFIRM}）`);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** 一轮：同步策略状态，然后推进到期的 PENDING 请求。 */
  async tick(now = Date.now()): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.policy.sync().catch((error) => {
        this.logger.warn(`策略状态同步失败: ${(error as Error).message}`);
      });
      const due = await this.prisma.r4RevocationRequest.findMany({
        where: {
          state: 'PENDING',
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date(now) } }],
        },
        orderBy: { createdAt: 'asc' },
        take: BATCH,
        select: { id: true },
      });
      for (const { id } of due) {
        if (this.stopped) break;
        await this.advance(id, now).catch((error) => {
          this.logger.error(`撤销请求 ${id} 推进失败: ${(error as Error).message}`);
        });
      }
    } finally {
      this.running = false;
    }
  }

  /** 推进一个请求：重放未决尝试，或按 live Grant 追加新的尝试。 */
  async advance(requestId: string, now = Date.now()): Promise<void> {
    const request = await this.prisma.r4RevocationRequest.findUnique({
      where: { id: requestId },
      include: { attempts: { orderBy: { ordinal: 'asc' } } },
    }) as RequestWithAttempts | null;
    if (!request || request.state !== 'PENDING') return;
    if (request.nextAttemptAt && request.nextAttemptAt.getTime() > now) return;

    const unresolved = request.attempts.find((attempt) => attempt.outcome === null);
    if (unresolved) {
      await this.deliverAttempt(request, unresolved, now);
      return;
    }
    const target = await this.pickTarget(request, now);
    if (!target) {
      await this.revocations.finishNoLiveTarget(request.id);
      return;
    }
    const attempt = await this.createAttempt(request, target);
    await this.deliverAttempt(request, attempt, now);
  }

  /**
   * 候选来自权威方自己的 r4_platform_grant：平台 egress 授权有效期就是 Grant 的
   * expires_at（≤300 秒），所以没有 live Grant 就证明不存在可出网的 authority。
   */
  private async pickTarget(request: RequestWithAttempts, now: number): Promise<R4PlatformGrant | null> {
    const grants = await this.prisma.r4PlatformGrant.findMany({
      where: { scheduleId: request.scheduleId, expiresAt: { gt: new Date(now) } },
      orderBy: { createdAt: 'desc' },
      take: this.config.R4_REVOCATION_MAX_TARGET_CANDIDATES,
    });
    if (grants.length === 0) return null;
    const tried = new Set(request.attempts.map((attempt) => attempt.targetJti));
    // 优先未尝试过的 live Grant；都试过时重试最新的一个——SCOPE_MISMATCH 只证明
    // 当时没有 authority 行，Grant 可能在之后才被准入，不能把它漏掉。
    return grants.find((grant) => !tried.has(grant.jti)) ?? grants[0] ?? null;
  }

  private async createAttempt(request: RequestWithAttempts, grant: R4PlatformGrant): Promise<R4RevocationAttempt> {
    const jws = await this.issuer.issue({
      scheduleId: request.scheduleId as PlatformScheduleId,
      workflowRunId: grant.workflowRunId,
      fenceSequence: String(request.fenceSequence),
      reasonCode: request.reasonCode as RevocationReasonCode,
      targetIssuer: this.config.ENGINE_BUDGET_GRANT_ISSUER,
      targetJti: grant.jti,
    });
    const claims = decodeJwt(jws);
    const ordinal = (request.attempts.at(-1)?.ordinal ?? 0) + 1;
    try {
      return await this.prisma.r4RevocationAttempt.create({
        data: {
          requestId: request.id,
          ordinal,
          commandJws: jws,
          commandSha256: createHash('sha256').update(jws, 'utf8').digest('hex'),
          revocationJti: String(claims.revocation_jti),
          targetIssuer: this.config.ENGINE_BUDGET_GRANT_ISSUER,
          targetJti: grant.jti,
          workflowRunId: grant.workflowRunId,
          fenceSequence: request.fenceSequence,
          issuedAt: new Date(Number(claims.iat) * 1000),
          expiresAt: new Date(Number(claims.exp) * 1000),
        },
      });
    } catch (error) {
      // 并发进程/重入：同 ordinal 已存在时复用它（仍然是本请求的尝试）。
      if ((error as { code?: string }).code === 'P2002') {
        const existing = await this.prisma.r4RevocationAttempt.findFirst({
          where: { requestId: request.id, ordinal },
        });
        if (existing) return existing;
      }
      throw error;
    }
  }

  private async deliverAttempt(
    request: RequestWithAttempts, attempt: R4RevocationAttempt, now: number,
  ): Promise<void> {
    let ack: string;
    try {
      ({ ack } = await this.client.deliver(attempt.commandJws));
    } catch (error) {
      await this.handleDeliveryError(request, attempt, error, now);
      return;
    }
    const claims = await this.verifier.verify(ack, {
      revocationJti: attempt.revocationJti,
      commandJws: attempt.commandJws,
      scheduleId: request.scheduleId,
      fenceSequence: String(attempt.fenceSequence),
    }, now).catch(() => null);
    if (!claims) {
      // ACK 验签失败既不是已撤销也不是未提交：保持 PENDING，原字节重试并告警。
      await this.revocations.noteTransientFailure(
        request.id, 'PLATFORM_REVOCATION_ACK_INVALID', this.nextAttemptAt(request, now),
      );
      return;
    }
    try {
      await this.revocations.markAcked(request.id, attempt.id, {
        receiptId: String(claims.jti),
        generation: String(claims.backend_generation),
        committedAt: Number(claims.committed_at),
        inFlightAttempts: String(claims.in_flight_attempts),
        ackSha256: createHash('sha256').update(ack, 'utf8').digest('hex'),
      });
    } catch (error) {
      // 另一个进程已把请求推进到终态：ACK 仍然有效，只是不需要再写。
      if ((error as Error).message !== 'R4_REVOCATION_REQUEST_STATE_CHANGED') throw error;
    }
  }

  private async handleDeliveryError(
    request: RequestWithAttempts,
    attempt: R4RevocationAttempt,
    error: unknown,
    now: number,
  ): Promise<void> {
    if (!(error instanceof RevocationDeliveryError)) {
      await this.revocations.noteTransientFailure(
        request.id, 'PLATFORM_REVOCATION_DELIVERY_UNKNOWN', this.nextAttemptAt(request, now),
      );
      return;
    }
    const { status, code } = error;
    if (status === 403 && code === 'PLATFORM_REVOCATION_SCOPE_MISMATCH') {
      // 该 target 没有已 committed 的 authority 行：确定性未命中，换/重试 live 候选。
      await this.revocations.markAttemptUntargeted(
        request.id, attempt.id, 'SCOPE_MISMATCH', status, code, new Date(now + SCOPE_RETRY_MS),
      );
      return;
    }
    if (status === 409 && code === 'PLATFORM_REVOCATION_EXPIRED') {
      // 已提交的同字节重放会返回原 ACK；这里拿到 EXPIRED 说明该尝试从未提交。
      await this.revocations.markAttemptUntargeted(
        request.id, attempt.id, 'EXPIRED_UNCOMMITTED', status, code, new Date(now),
      );
      return;
    }
    if (code === 'PLATFORM_REVOCATION_REUSED'
      || code === 'PLATFORM_REVOCATION_SEQUENCE_CONFLICT'
      || code === 'PLATFORM_REVOCATION_INVALID') {
      const outcome: AttemptOutcome =
        code === 'PLATFORM_REVOCATION_REUSED' ? 'REUSED'
          : code === 'PLATFORM_REVOCATION_SEQUENCE_CONFLICT' ? 'SEQUENCE_CONFLICT'
            : 'INVALID';
      await this.revocations.markAttemptUntargeted(request.id, attempt.id, outcome, status, code, null);
      await this.revocations.setTerminal(
        request.id,
        code === 'PLATFORM_REVOCATION_SEQUENCE_CONFLICT' ? 'STORED_STATE_CONFLICT' : 'BLOCKED',
        `${status}:${code}`,
      );
      return;
    }
    // 429 / 503 / 网络错误 / 泛 409：结果未知，原字节重试。
    await this.revocations.noteTransientFailure(
      request.id, `${status}:${code}`, this.nextAttemptAt(request, now),
    );
  }

  private nextAttemptAt(request: RequestWithAttempts, now: number): Date {
    const exponent = Math.min(Math.max(request.attemptCount, 0), 4);
    return new Date(now + Math.min(BASE_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS));
  }
}

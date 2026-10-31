import { describe, expect, it, vi } from 'vitest';
import type { R4PlatformGrant, R4RevocationAttempt, R4RevocationRequest } from '@prisma/client';
import type { AppConfig } from '../config/configuration.js';
import type { PrismaService } from '../shared/prisma.service.js';
import { RevocationDeliveryError } from './revocation-client.service.js';
import { PlatformRevocationDeliveryService } from './platform-revocation-delivery.service.js';
import type { PlatformPolicyStateService } from './platform-policy-state.service.js';
import type { PlatformRevocationService } from './platform-revocation.service.js';

const NOW = 1_793_600_000_000;
const REQUEST_ID = '2b7f4c1e-9a3d-4f5b-8c6e-1d2a3b4c5d6e';
const ATTEMPT_ID = '3c8a5d2f-1b4e-4a6c-9d7f-2e3b4c5d6e7f';
const REVOCATION_JTI = '4d9b6e3a-2c5f-4b7d-8e8a-3f4c5d6e7f80';
const RECEIPT_ID = '5e0c7f4b-3d6a-4c8e-9f9b-4a5d6e7f8091';
const TARGET_JTI = '6f1d8a5c-4e7b-4d9f-8a0c-5b6e7f809102';
const WORKFLOW_RUN = '709e9b6d-5f8c-4e0a-9b1d-6c7f80910213';

function fakeJws(payload: Record<string, unknown>): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'RS256', kid: 'test', typ: 't' })}.${b64(payload)}.c2ln`;
}

function attempt(overrides: Partial<R4RevocationAttempt> = {}): R4RevocationAttempt {
  return {
    id: ATTEMPT_ID, requestId: REQUEST_ID, ordinal: 1,
    commandJws: fakeJws({ iat: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 120, revocation_jti: REVOCATION_JTI }),
    commandSha256: 'a'.repeat(64), revocationJti: REVOCATION_JTI,
    targetIssuer: 'https://127.0.0.1:18446/execution-budget',
    targetJti: TARGET_JTI, workflowRunId: WORKFLOW_RUN, fenceSequence: 7n,
    issuedAt: new Date(NOW), expiresAt: new Date(NOW + 120_000),
    outcome: null, httpStatus: null, errorCode: null, ackSha256: null,
    createdAt: new Date(NOW), updatedAt: new Date(NOW),
    ...overrides,
  } as R4RevocationAttempt;
}

function request(overrides: Partial<R4RevocationRequest> & { attempts?: R4RevocationAttempt[] } = {}) {
  return {
    id: REQUEST_ID, scheduleId: 'acq-sweep', reasonCode: 'OPERATOR_HOLD', source: 'OPERATOR',
    requestedBy: 'ops', note: null, dedupeKey: null, state: 'PENDING', deliveryUnknown: false,
    fenceSequence: 7n, confirmedBy: null, confirmedAt: null, nextAttemptAt: null, attemptCount: 0,
    ackReceiptId: null, ackGeneration: null, ackCommittedAt: null, ackInFlightAttempts: null,
    ackSha256: null, lastError: null, createdAt: new Date(NOW), updatedAt: new Date(NOW),
    attempts: [],
    ...overrides,
  } as R4RevocationRequest & { attempts: R4RevocationAttempt[] };
}

function fixture(req: R4RevocationRequest & { attempts: R4RevocationAttempt[] }) {
  const config = {
    R4_REVOCATION_TRIGGER_ENABLED: true,
    R4_REVOCATION_MAX_TARGET_CANDIDATES: 8,
    ENGINE_BUDGET_GRANT_ISSUER: 'https://127.0.0.1:18446/execution-budget',
  } as unknown as AppConfig;
  const findUnique = vi.fn().mockResolvedValue(req);
  const requestFindMany = vi.fn().mockResolvedValue([]);
  const grantFindMany = vi.fn().mockResolvedValue([]);
  const attemptCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => attempt(data as Partial<R4RevocationAttempt>));
  const prisma = {
    r4RevocationRequest: { findUnique, findMany: requestFindMany },
    r4PlatformGrant: { findMany: grantFindMany },
    r4RevocationAttempt: { create: attemptCreate, findFirst: vi.fn().mockResolvedValue(null) },
  } as unknown as PrismaService;
  const revocations = {
    markAcked: vi.fn().mockResolvedValue(undefined),
    markAttemptUntargeted: vi.fn().mockResolvedValue(undefined),
    noteTransientFailure: vi.fn().mockResolvedValue(undefined),
    setTerminal: vi.fn().mockResolvedValue(undefined),
    finishNoLiveTarget: vi.fn().mockResolvedValue(undefined),
  } as unknown as PlatformRevocationService;
  const policy = { sync: vi.fn().mockResolvedValue(undefined) } as unknown as PlatformPolicyStateService;
  const issuer = {
    issue: vi.fn().mockResolvedValue(fakeJws({
      iat: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 120,
      revocation_jti: '8a2e0c7d-6b9f-4f1c-8b3e-7d8091021324',
    })),
  };
  const client = { deliver: vi.fn().mockResolvedValue({ ack: 'ack-token' }) };
  const verifier = {
    verify: vi.fn().mockResolvedValue({
      jti: RECEIPT_ID, backend_generation: '2', committed_at: Math.floor(NOW / 1000),
      in_flight_attempts: '0',
    }),
  };
  return {
    service: new PlatformRevocationDeliveryService(
      config, prisma, revocations, policy,
      issuer as never, client as never, verifier as never,
    ),
    findUnique, grantFindMany, attemptCreate, revocations, issuer, client, verifier,
  };
}

describe('撤销投递', () => {
  it('ACK 验签通过 → markAcked 携带完整事实', async () => {
    const { service, revocations } = fixture(request({ attempts: [attempt()] }));
    await service.advance(REQUEST_ID, NOW);
    expect(revocations.markAcked).toHaveBeenCalledWith(REQUEST_ID, ATTEMPT_ID, expect.objectContaining({
      receiptId: RECEIPT_ID, generation: '2', committedAt: Math.floor(NOW / 1000), inFlightAttempts: '0',
    }));
  });

  it('503/网络未知 → 原字节重试，不宣布未提交', async () => {
    const { service, revocations, client } = fixture(request({ attempts: [attempt()] }));
    client.deliver.mockRejectedValue(new RevocationDeliveryError(503, 'PLATFORM_REVOCATION_UNAVAILABLE'));
    await service.advance(REQUEST_ID, NOW);
    expect(revocations.noteTransientFailure).toHaveBeenCalledWith(
      REQUEST_ID, '503:PLATFORM_REVOCATION_UNAVAILABLE', expect.any(Date),
    );
    expect(revocations.markAttemptUntargeted).not.toHaveBeenCalled();
    expect(revocations.setTerminal).not.toHaveBeenCalled();
  });

  it('ACK 验签失败 → 保持 PENDING 并告警，不记成功', async () => {
    const { service, revocations, verifier } = fixture(request({ attempts: [attempt()] }));
    verifier.verify.mockResolvedValue(null as never);
    await service.advance(REQUEST_ID, NOW);
    expect(revocations.markAcked).not.toHaveBeenCalled();
    expect(revocations.noteTransientFailure).toHaveBeenCalledWith(
      REQUEST_ID, 'PLATFORM_REVOCATION_ACK_INVALID', expect.any(Date),
    );
  });

  it('403 SCOPE_MISMATCH → 确定性未命中，允许换/重试候选', async () => {
    const { service, revocations, client } = fixture(request({ attempts: [attempt()] }));
    client.deliver.mockRejectedValue(new RevocationDeliveryError(403, 'PLATFORM_REVOCATION_SCOPE_MISMATCH'));
    await service.advance(REQUEST_ID, NOW);
    expect(revocations.markAttemptUntargeted).toHaveBeenCalledWith(
      REQUEST_ID, ATTEMPT_ID, 'SCOPE_MISMATCH', 403,
      'PLATFORM_REVOCATION_SCOPE_MISMATCH', expect.any(Date),
    );
  });

  it('409 EXPIRED 表示该尝试从未提交，可追加 successor', async () => {
    const { service, revocations, client } = fixture(request({ attempts: [attempt()] }));
    client.deliver.mockRejectedValue(new RevocationDeliveryError(409, 'PLATFORM_REVOCATION_EXPIRED'));
    await service.advance(REQUEST_ID, NOW);
    expect(revocations.markAttemptUntargeted).toHaveBeenCalledWith(
      REQUEST_ID, ATTEMPT_ID, 'EXPIRED_UNCOMMITTED', 409,
      'PLATFORM_REVOCATION_EXPIRED', expect.any(Date),
    );
  });

  it('409 SEQUENCE_CONFLICT 不自动 +1，停在 STORED_STATE_CONFLICT', async () => {
    const { service, revocations, client } = fixture(request({ attempts: [attempt()] }));
    client.deliver.mockRejectedValue(new RevocationDeliveryError(409, 'PLATFORM_REVOCATION_SEQUENCE_CONFLICT'));
    await service.advance(REQUEST_ID, NOW);
    expect(revocations.setTerminal).toHaveBeenCalledWith(
      REQUEST_ID, 'STORED_STATE_CONFLICT', '409:PLATFORM_REVOCATION_SEQUENCE_CONFLICT',
    );
  });

  it('400 INVALID → BLOCKED（配置/密钥问题）', async () => {
    const { service, revocations, client } = fixture(request({ attempts: [attempt()] }));
    client.deliver.mockRejectedValue(new RevocationDeliveryError(400, 'PLATFORM_REVOCATION_INVALID'));
    await service.advance(REQUEST_ID, NOW);
    expect(revocations.setTerminal).toHaveBeenCalledWith(
      REQUEST_ID, 'BLOCKED', '400:PLATFORM_REVOCATION_INVALID',
    );
  });

  it('没有未决尝试且没有 live Grant → NO_LIVE_TARGET 终态', async () => {
    const { service, revocations } = fixture(request({ attempts: [attempt({ outcome: 'EXPIRED_UNCOMMITTED' })] }));
    await service.advance(REQUEST_ID, NOW);
    expect(revocations.finishNoLiveTarget).toHaveBeenCalledWith(REQUEST_ID);
  });

  it('没有未决尝试但有 live Grant → 签发新尝试并投递', async () => {
    const grant = {
      jti: TARGET_JTI, scheduleId: 'acq-sweep', workflowRunId: WORKFLOW_RUN,
      expiresAt: new Date(NOW + 120_000), createdAt: new Date(NOW),
    } as unknown as R4PlatformGrant;
    const { service, grantFindMany, issuer, client, attemptCreate, revocations } = fixture(request());
    grantFindMany.mockResolvedValue([grant]);
    await service.advance(REQUEST_ID, NOW);
    expect(issuer.issue).toHaveBeenCalledWith(expect.objectContaining({
      scheduleId: 'acq-sweep', workflowRunId: WORKFLOW_RUN, fenceSequence: '7',
      reasonCode: 'OPERATOR_HOLD', targetJti: TARGET_JTI,
    }));
    expect(attemptCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ requestId: REQUEST_ID, ordinal: 1, targetJti: TARGET_JTI }),
    }));
    expect(client.deliver).toHaveBeenCalled();
    expect(revocations.markAcked).toHaveBeenCalled();
  });
});

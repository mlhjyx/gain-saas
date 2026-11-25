import { describe, expect, it, vi } from 'vitest';
import { EngineHttp } from '../bff/engine-http.js';
import type { Request } from 'express';
import { EngineContactEligibilityChecker } from './outreach-eligibility.checker.js';
import { OutreachBounceWritebackService } from './outreach-bounce-writeback.service.js';

const TENANT = { userId: 'u-1', workspaceId: '11111111-1111-4111-8111-111111111111', role: 'member' } as never;
const sha256Hex = (input: string): string =>
  // 与 checker 同口径（trim+lowercase 后 sha256）
  (require('node:crypto') as typeof import('node:crypto')).createHash('sha256').update(input).digest('hex');

function engineWith(results: Array<Record<string, unknown>> | Error, status = 200) {
  const engine = new EngineHttp({} as never, {} as never);
  const call = vi.fn(async () => {
    if (results instanceof Error) throw results;
    return {
      status,
      body: { data: { results } },
      contentType: 'application/json',
      headers: {},
    };
  });
  (engine as unknown as { call: typeof call }).call = call;
  return { engine, call };
}

describe('EngineContactEligibilityChecker', () => {
  it('返回四态与 allowedActions;哈希键还原为 canonical email', async () => {
    const email = 'Lead@Example.com ';
    const canonical = email.trim().toLowerCase();
    const { engine, call } = engineWith([
      { emailHash: sha256Hex(canonical), found: true, state: 'VALID', score: 95, allowedActions: ['display', 'match', 'outreach'] },
    ]);
    const checker = new EngineContactEligibilityChecker(engine, { OUTREACH_ENGINE_SERVICE_TOKEN: 'token-16-chars-ok' } as never);
    const out = await checker.check(TENANT, [email]);
    expect(out.get(canonical)).toMatchObject({ found: true, state: 'VALID', score: 95 });
    expect(out.get(canonical)!.allowedActions).toContain('outreach');
    expect(call.mock.calls[0]![3]).toMatchObject({
      // 契约:引擎 DTO 必填 workspaceId——缺失会被 ValidationPipe 400(曾致 flag-on 全批拒绝)
      body: { workspaceId: TENANT.workspaceId, emails: [canonical] },
      headers: { 'x-service-token': 'token-16-chars-ok' },
    });
  });

  it('引擎未命中的邮箱 → found=false（调用方按拒发处理）', async () => {
    const { engine } = engineWith([]);
    const checker = new EngineContactEligibilityChecker(engine, { OUTREACH_ENGINE_SERVICE_TOKEN: 'token-16-chars-ok' } as never);
    const out = await checker.check(TENANT, ['ghost@example.com']);
    expect(out.get('ghost@example.com')).toMatchObject({ found: false, state: 'UNKNOWN', allowedActions: [] });
  });

  it('>50 封分块串行调用', async () => {
    const emails = Array.from({ length: 60 }, (_, i) => `p${i}@example.com`);
    const { engine, call } = engineWith([]);
    const checker = new EngineContactEligibilityChecker(engine, { OUTREACH_ENGINE_SERVICE_TOKEN: 'token-16-chars-ok' } as never);
    await checker.check(TENANT, emails);
    expect(call).toHaveBeenCalledTimes(2);
    const first = call.mock.calls[0]![3] as { body: { emails: string[] } };
    const second = call.mock.calls[1]![3] as { body: { emails: string[] } };
    expect(first.body.emails).toHaveLength(50);
    expect(second.body.emails).toHaveLength(10);
  });

  it('引擎 5xx → 抛错（调用方整批 fail-closed）', async () => {
    const { engine } = engineWith([], 503);
    const checker = new EngineContactEligibilityChecker(engine, { OUTREACH_ENGINE_SERVICE_TOKEN: 'token-16-chars-ok' } as never);
    await expect(checker.check(TENANT, ['a@example.com'])).rejects.toThrow('HTTP 503');
  });

  it('Batch 1.4-C：透传引擎侧 recommendedChannel（linkedin_first）与 d3Policy', async () => {
    const email = 'm.rossi@refeel-epc.it';
    const { engine } = engineWith([
      {
        emailHash: sha256Hex(email),
        found: true,
        state: 'CATCH_ALL_RISKY',
        score: 78,
        allowedActions: ['display', 'match'],
        recommendedChannel: 'linkedin_first',
        d3Policy: {
          emailPolicy: 'LEGITIMATE_INTEREST_STRICT',
          emailAllowedNow: true,
          complianceTag: 'IT:GDPR_LI+ART14',
          requiresArticle14Notice: true,
          recommendedSequence: ['email_li_art14', 'linkedin_copilot'],
        },
      },
    ]);
    const checker = new EngineContactEligibilityChecker(engine, { OUTREACH_ENGINE_SERVICE_TOKEN: 'token-16-chars-ok' } as never);
    const out = await checker.check(TENANT, [email]);
    expect(out.get(email)).toMatchObject({
      state: 'CATCH_ALL_RISKY',
      recommendedChannel: 'linkedin_first',
      d3Policy: {
        emailPolicy: 'LEGITIMATE_INTEREST_STRICT',
        complianceTag: 'IT:GDPR_LI+ART14',
        requiresArticle14Notice: true,
      },
    });
  });
});

describe('OutreachBounceWritebackService', () => {
  const POINT = '22222222-2222-4222-8222-222222222222';

  function serviceWith(opts: { token?: string; status?: number; rows?: Array<Record<string, unknown>> } = {}) {
    const { engine, call } = engineWith([], opts.status ?? 200);
    const rows = (opts.rows ?? []) as Array<{ id: string; workspaceId: string; contactPointId: string; event: string; messageId: string; smtpCode: string | null; receivedAt: Date; attempts: number }>;
    const prisma = {
      outreachBounceWriteback: {
        create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ ...args.data, id: 'w-1' })),
        findMany: vi.fn(async () => rows),
        update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => args.data),
      },
    };
    const service = new OutreachBounceWritebackService(
      prisma as never,
      engine,
      { ...(opts.token === undefined ? {} : { OUTREACH_ENGINE_SERVICE_TOKEN: opts.token }) } as never,
    );
    return { service, call, prisma };
  }

  it('入队成功;contactPointId 非 UUID 直接丢弃不落队', async () => {
    const ok = serviceWith();
    await ok.service.enqueue(TENANT, { contactPointId: POINT, event: 'hard_bounce', messageId: 'm-1' });
    expect(ok.prisma.outreachBounceWriteback.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ workspaceId: TENANT.workspaceId, contactPointId: POINT, event: 'hard_bounce', messageId: 'm-1' }),
    });
    const bad = serviceWith();
    await bad.service.enqueue(TENANT, { contactPointId: 'not-a-uuid', event: 'hard_bounce', messageId: 'm-2' });
    expect(bad.prisma.outreachBounceWriteback.create).not.toHaveBeenCalled();
  });

  it('drain:调用引擎带服务令牌与幂等键;成功置 DONE', async () => {
    const svc = serviceWith({
      token: 'token-16-chars-ok',
      rows: [{ id: 'w-1', workspaceId: TENANT.workspaceId, contactPointId: POINT, event: 'hard_bounce', messageId: 'm-1', smtpCode: '550', receivedAt: new Date('2026-11-21T00:00:00Z'), attempts: 0 }],
    });
    const result = await svc.service.drain();
    expect(result).toEqual({ done: 1, failed: 0, skipped: 0 });
    expect(svc.call.mock.calls[0]![1]).toBe('POST');
    expect(String(svc.call.mock.calls[0]![2])).toContain(`/contact-points/${POINT}/bounce-events`);
    expect(svc.call.mock.calls[0]![3]).toMatchObject({
      body: expect.objectContaining({ workspaceId: TENANT.workspaceId, event: 'hard_bounce', messageId: 'm-1', smtpCode: '550' }),
      headers: { 'x-service-token': 'token-16-chars-ok' },
    });
    expect(svc.prisma.outreachBounceWriteback.update).toHaveBeenCalledWith({
      where: { id: 'w-1' },
      data: { status: 'DONE', lastError: null },
    });
  });

  it('引擎 404(联系点已删) → 永久失败不再重试', async () => {
    const svc = serviceWith({
      status: 404,
      token: 'token-16-chars-ok',
      rows: [{ id: 'w-1', workspaceId: TENANT.workspaceId, contactPointId: POINT, event: 'hard_bounce', messageId: 'm-1', smtpCode: null, receivedAt: new Date(), attempts: 0 }],
    });
    const result = await svc.service.drain();
    expect(result.failed).toBe(1);
    expect(svc.prisma.outreachBounceWriteback.update).toHaveBeenCalledWith({
      where: { id: 'w-1' },
      data: expect.objectContaining({ status: 'FAILED', attempts: 1 }),
    });
  });

  it('引擎 5xx → attempts+1 保持 PENDING(未达上限不终结)', async () => {
    const svc = serviceWith({
      status: 503,
      token: 'token-16-chars-ok',
      rows: [{ id: 'w-1', workspaceId: TENANT.workspaceId, contactPointId: POINT, event: 'soft_bounce', messageId: 'm-2', smtpCode: null, receivedAt: new Date(), attempts: 2 }],
    });
    const result = await svc.service.drain();
    expect(result.skipped).toBe(1);
    expect(svc.prisma.outreachBounceWriteback.update).toHaveBeenCalledWith({
      where: { id: 'w-1' },
      data: { status: 'PENDING', attempts: 3, lastError: expect.stringContaining('503') },
    });
  });

  it('未配置服务令牌 → drain 直跳(不烧尝试次数)', async () => {
    const svc = serviceWith({ token: undefined });
    const result = await svc.service.drain();
    expect(result).toEqual({ done: 0, failed: 0, skipped: 0 });
    expect(svc.prisma.outreachBounceWriteback.findMany).not.toHaveBeenCalled();
  });
});

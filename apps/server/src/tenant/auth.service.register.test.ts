import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AuthService, findEnterpriseConflict, normalizeCompanyName } from './auth.service.js';
import type { PrismaService } from '../shared/prisma.service.js';

/** 一企一空间：注册企业查重（2026-11-21 产品决策，硬拦截）。 */

describe('normalizeCompanyName / findEnterpriseConflict', () => {
  it('归一化:NFKC+去空白+小写', () => {
    expect(normalizeCompanyName('  琏升 科技Ａ公司 ')).toBe('琏升科技ａ公司'.normalize('NFKC').toLowerCase());
    expect(normalizeCompanyName('Acme\t Corp')).toBe('acmecorp');
  });

  it('精确命中(含空白/全半角差异)', () => {
    expect(findEnterpriseConflict('宁波宏达机电有限公司', ['宁波宏达 机电有限公司'])).toBe('宁波宏达 机电有限公司');
  });

  it('"+1"式后缀重复命中(包含关系,较短方≥6字)', () => {
    expect(findEnterpriseConflict('琏升科技股份有限公司1', ['琏升科技股份有限公司'])).toBe('琏升科技股份有限公司');
    expect(findEnterpriseConflict('东莞市盛源鑫实业有限公司', ['东莞市盛源鑫实业有限公司1'])).toBe('东莞市盛源鑫实业有限公司1');
  });

  it('不同城市前缀互不包含→放行;短名(≤5字)不做包含判断', () => {
    expect(findEnterpriseConflict('宁波市盛源鑫实业有限公司', ['东莞市盛源鑫实业有限公司'])).toBeNull();
    expect(findEnterpriseConflict('11', ['11222222'])).toBeNull();
  });

  it('完全不同的名称→放行', () => {
    expect(findEnterpriseConflict('甲公司', ['乙公司', '丙公司'])).toBeNull();
  });
});

function fixture(
  activeWorkspaces: Array<{ name: string; createdAt: Date }>,
  options?: {
    signupBonusCredits?: number;
    signupBonusExpiresDays?: number;
    walletGrantBonus?: ReturnType<typeof vi.fn>;
  },
) {
  const prisma = {
    user: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({ id: 'u-1' })) },
    workspace: {
      findMany: vi.fn(async () => activeWorkspaces),
      create: vi.fn(async () => ({ id: 'w-1', name: 'x', memberships: [{ id: 'm-1' }] })),
    },
    // 事务回调直接复用同一 mock:advisory lock 的 $executeRaw 也在这里断言
    $transaction: vi.fn(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma as never)),
    $executeRaw: vi.fn(async () => 0),
  } as unknown as PrismaService;
  const audit = { record: vi.fn(async () => undefined) };
  const sessions = { issue: vi.fn(async () => ({ jti: 'j-1' })) };
  const wallet = options?.walletGrantBonus
    ? { grantBonus: options.walletGrantBonus }
    : undefined;
  const service = new AuthService(
    {
      INVITE_CODE: undefined,
      WALLET_SIGNUP_BONUS_CREDITS: options?.signupBonusCredits ?? 0,
      WALLET_SIGNUP_BONUS_EXPIRES_DAYS: options?.signupBonusExpiresDays ?? 0,
    } as never,
    prisma,
    sessions as never,
    audit as never,
    wallet as never,
  );
  return { service, prisma, audit, sessions, wallet };
}

const input = (companyName: string) => ({
  email: 'new-user@example.test',
  password: 'abcd1234ef',
  companyName,
});

describe('AuthService.register（一企一空间查重）', () => {
  it('精确命中已开通企业 → 409 COMPANY_WORKSPACE_EXISTS，meta 带企业名与日期，不落任何行', async () => {
    const { service, prisma } = fixture([
      { name: '宁波宏达机电有限公司', createdAt: new Date('2026-10-28T00:00:00Z') },
    ]);
    const err = await service.register(input('宁波宏达机电有限公司')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as { error: { code: string }; meta: Record<string, string> };
    expect(body.error.code).toBe('COMPANY_WORKSPACE_EXISTS');
    expect(body.meta.existingWorkspaceName).toBe('宁波宏达机电有限公司');
    expect(body.meta.existingCreatedAt).toBe('2026-10-28');
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect((prisma.workspace.create as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    // 并发防护:查重发生在 advisory lock 之后、同一事务内
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it('后缀"+1"式重复同样被拦', async () => {
    const { service } = fixture([{ name: '琏升科技股份有限公司', createdAt: new Date('2026-11-08T00:00:00Z') }]);
    const err = await service.register(input('琏升科技股份有限公司1')).catch((e: unknown) => e);
    expect((err as ConflictException).getResponse()).toMatchObject({ error: { code: 'COMPANY_WORKSPACE_EXISTS' } });
  });

  it('不同企业名称正常注册（workspace.findMany 只查 ACTIVE）', async () => {
    const { service, prisma } = fixture([{ name: '别的公司', createdAt: new Date('2026-11-01T00:00:00Z') }]);
    const result = await service.register(input('全新企业有限公司'));
    expect(result.workspace).toBeTruthy();
    expect((prisma.workspace.findMany as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'ACTIVE' } }),
    );
    expect(prisma.user.create).toHaveBeenCalled();
  });

  it('邮箱已注册优先于企业查重（EMAIL_TAKEN）', async () => {
    const prisma = {
      user: { findUnique: vi.fn(async () => ({ id: 'u-0' })), create: vi.fn() },
      workspace: { findMany: vi.fn(async () => []), create: vi.fn() },
    } as unknown as PrismaService;
    const service = new AuthService({ INVITE_CODE: undefined } as never, prisma, { issue: vi.fn() } as never, { record: vi.fn() } as never);
    const err = await service.register(input('任意公司')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getResponse()).toMatchObject({ error: { code: 'EMAIL_TAKEN' } });
    expect((prisma.workspace.findMany as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('WALLET_SIGNUP_BONUS_CREDITS > 0 时注册后自动按幂等键发放试用积分（可配有效期）', async () => {
    const grantBonus = vi.fn(async () => ({ idempotent: false }));
    const { service } = fixture([], {
      signupBonusCredits: 200,
      signupBonusExpiresDays: 30,
      walletGrantBonus: grantBonus,
    });
    const result = await service.register(input('新光伏科技股份有限公司'));
    expect(result.workspace.id).toBe('w-1');
    expect(grantBonus).toHaveBeenCalledTimes(1);
    const [workspaceId, body, actorId] = grantBonus.mock.calls[0] as [string, Record<string, unknown>, string];
    expect(workspaceId).toBe('w-1');
    expect(actorId).toBe('system:signup-bonus');
    expect(body).toMatchObject({
      credits: '200',
      sourceType: 'PROMO_BONUS',
      externalOrderId: 'signup-bonus:w-1',
    });
    expect(typeof body.expiresAt).toBe('string');
    expect(new Date(body.expiresAt as string).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });

  it('WALLET_SIGNUP_BONUS_CREDITS = 0 时不触发赠点发放', async () => {
    const grantBonus = vi.fn(async () => ({ idempotent: false }));
    const { service } = fixture([], {
      signupBonusCredits: 0,
      walletGrantBonus: grantBonus,
    });
    await service.register(input('无赠点企业有限公司'));
    expect(grantBonus).not.toHaveBeenCalled();
  });

  it('注册赠点发放异常时 fail-open，不阻断新企业注册与签发会话', async () => {
    const grantBonus = vi.fn(async () => {
      throw new Error('wallet db hiccup');
    });
    const { service } = fixture([], {
      signupBonusCredits: 200,
      walletGrantBonus: grantBonus,
    });
    const result = await service.register(input('容错注册企业有限公司'));
    expect(grantBonus).toHaveBeenCalledTimes(1);
    expect(result.workspace.id).toBe('w-1');
    expect(result.session).toEqual({ jti: 'j-1' });
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import type { AuditService } from '../shared/audit.service.js';
import type { PrismaService } from '../shared/prisma.service.js';
import { CampaignService } from './campaign.service.js';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BATCH = '11111111-1111-4111-8111-111111111111';
const PLAN_HASH = 'p'.repeat(64);

interface Row {
  [key: string]: unknown;
}

class FakeVerifyPrisma {
  authorizations: Row[] = [];
  workspaces: Row[] = [{ id: WS, status: 'ACTIVE' }];

  readonly campaignExecutionAuthorization = {
    findFirst: async ({ where }: { where: Row }) =>
      this.authorizations.find(
        (row) =>
          row.id === where.id &&
          (!where.workspaceId || row.workspaceId === where.workspaceId),
      ) ?? null,
  };
  readonly workspace = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.workspaces.find((row) => row.id === where.id) ?? null,
  };
}

function build(scope: Row, options: { state?: string; expiresInMs?: number } = {}) {
  const prisma = new FakeVerifyPrisma();
  prisma.authorizations.push({
    id: 'auth-1',
    workspaceId: WS,
    campaignId: 'campaign-1',
    revisionId: 'revision-1',
    planHash: PLAN_HASH,
    scope,
    state: options.state ?? 'ISSUED',
    maxUses: 2,
    uses: 0,
    expiresAt: new Date(Date.now() + (options.expiresInMs ?? 3_600_000)),
  });
  const signer = {
    verify: vi.fn(async (token: string) =>
      token === 'good-token'
        ? { authorizationId: 'auth-1', workspaceId: WS, campaignId: 'campaign-1', revisionId: 'revision-1', planHash: PLAN_HASH, scope }
        : null,
    ),
  };
  const service = new CampaignService(
    prisma as unknown as PrismaService,
    { record: vi.fn(async () => undefined) } as unknown as AuditService,
    signer as never,
    {} as never,
    { CAMPAIGN_APPROVAL_TTL_HOURS: 72, CAMPAIGN_AUTHZ_TTL_MINUTES: 30, CAMPAIGN_AUDIENCE_SIZE_CAP_MAX: 1000 } as AppConfig,
  );
  return { service, prisma };
}

const v2Scope = {
  schemaVersion: 'campaign-authz/v2',
  campaignId: null,
  actions: [
    {
      type: 'outreach.email.send',
      batchId: BATCH,
      audience: { contactRefsHash: 'a'.repeat(64), count: 2 },
      template: { contentHash: 'b'.repeat(64) },
    },
  ],
};

describe('CampaignService.verifyAuthorization · v2 分支（P4-03 签发对端校验）', () => {
  it('v2 scope：按 batchId 绑定校验；不带 batchId 也接受同类型动作', async () => {
    const { service } = build(v2Scope);
    const matching = await service.verifyAuthorization({
      token: 'good-token',
      planHash: PLAN_HASH,
      action: { type: 'outreach.email.send', batchId: BATCH },
    });
    expect(matching.valid).toBe(true);
    if (matching.valid) {
      expect(matching.authorization.remainingUses).toBe(2);
      expect((matching.authorization.scope as Row).schemaVersion).toBe('campaign-authz/v2');
    }

    const withoutBatch = await service.verifyAuthorization({
      token: 'good-token',
      planHash: PLAN_HASH,
      action: { type: 'outreach.email.send' },
    });
    expect(withoutBatch.valid).toBe(true);
  });

  it('负向：batchId 不符 / 动作类型不符 / 无效 token / 撤销 / 过期', async () => {
    const { service } = build(v2Scope);
    expect(
      (
        await service.verifyAuthorization({
          token: 'good-token',
          planHash: PLAN_HASH,
          action: { type: 'outreach.email.send', batchId: '99999999-9999-4999-8999-999999999999' },
        })
      ).valid,
    ).toBe(false);
    expect(
      (
        await service.verifyAuthorization({
          token: 'good-token',
          planHash: PLAN_HASH,
          action: { type: 'discovery' },
        })
      ).valid,
    ).toBe(false);
    expect(
      (
        await service.verifyAuthorization({
          token: 'bad-token',
          planHash: PLAN_HASH,
          action: { type: 'outreach.email.send' },
        })
      ).valid,
    ).toBe(false);

    const revoked = build(v2Scope, { state: 'REVOKED' });
    const revokedResult = await revoked.service.verifyAuthorization({
      token: 'good-token',
      planHash: PLAN_HASH,
      action: { type: 'outreach.email.send' },
    });
    expect(revokedResult).toMatchObject({ valid: false, reason: 'CAMPAIGN_AUTHORIZATION_REVOKED' });

    const expired = build(v2Scope, { expiresInMs: -1000 });
    const expiredResult = await expired.service.verifyAuthorization({
      token: 'good-token',
      planHash: PLAN_HASH,
      action: { type: 'outreach.email.send' },
    });
    expect(expiredResult).toMatchObject({ valid: false, reason: 'CAMPAIGN_AUTHORIZATION_EXPIRED' });
  });

  it('v1 scope 行为不变：icpIds 子集校验仍生效', async () => {
    const v1Scope = { actions: [{ type: 'discovery', icpIds: ['icp-1', 'icp-2'] }], sizeCap: 100 };
    const { service } = build(v1Scope);
    const ok = await service.verifyAuthorization({
      token: 'good-token',
      planHash: PLAN_HASH,
      action: { type: 'discovery', icpIds: ['icp-1'] },
    });
    expect(ok.valid).toBe(true);
    const outOfScope = await service.verifyAuthorization({
      token: 'good-token',
      planHash: PLAN_HASH,
      action: { type: 'discovery', icpIds: ['icp-9'] },
    });
    expect(outOfScope.valid).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { CampaignTokenSigner } from './campaign-token.signer.js';

function buildSigner(): CampaignTokenSigner {
  const config = { SESSION_SECRET: 'x'.repeat(32) } as AppConfig;
  return new CampaignTokenSigner(config);
}

const claims = {
  authorizationId: '33333333-3333-4333-8333-333333333333',
  workspaceId: '44444444-4444-4444-8444-444444444444',
  campaignId: '55555555-5555-4555-8555-555555555555',
  revisionId: '66666666-6666-4666-8666-666666666666',
  planHash: 'a'.repeat(64),
  scope: { actions: [{ type: 'discovery', icpIds: ['77777777-7777-4777-8777-777777777777'] }] },
};

describe('CampaignTokenSigner', () => {
  it('签发/验证往返一致', async () => {
    const signer = buildSigner();
    const token = await signer.sign(claims, 300);
    const parsed = await signer.verify(token);
    expect(parsed).not.toBeNull();
    expect(parsed!.authorizationId).toBe(claims.authorizationId);
    expect(parsed!.planHash).toBe(claims.planHash);
  });

  it('篡改令牌验证失败', async () => {
    const signer = buildSigner();
    const token = await signer.sign(claims, 300);
    expect(await signer.verify(`${token.slice(0, -2)}xx`)).toBeNull();
  });

  it('过期令牌验证失败', async () => {
    const signer = buildSigner();
    const token = await signer.sign(claims, -10);
    expect(await signer.verify(token)).toBeNull();
  });

  it('不同 SESSION_SECRET 的签名互不认可（HKDF 派生隔离）', async () => {
    const a = buildSigner();
    const b = new CampaignTokenSigner({ SESSION_SECRET: 'y'.repeat(32) } as AppConfig);
    const token = await a.sign(claims, 300);
    expect(await b.verify(token)).toBeNull();
  });
});

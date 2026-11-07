import { describe, expect, it } from 'vitest';
import { campaignPlanV0JsonSchema, validateCampaignPlan } from './campaign-plan.schema.js';
import { ICP_A, ICP_B, validPlan } from './campaign-plan.fixtures.js';

describe('CampaignPlan v0 validator', () => {
  it('接受最小合法计划', () => {
    const result = validateCampaignPlan(validPlan());
    expect(result.ok).toBe(true);
  });

  it('拒绝缺失 schemaVersion', () => {
    const plan = validPlan();
    delete plan.schemaVersion;
    const result = validateCampaignPlan(plan);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
  });

  it('拒绝非整数 sizeCap（指纹语义只接受整数）', () => {
    const result = validateCampaignPlan(validPlan({ audience: { icpIds: [ICP_A], sizeCap: 1.5 } }));
    expect(result.ok).toBe(false);
  });

  it('拒绝 sizeCap 超界', () => {
    expect(validateCampaignPlan(validPlan({ audience: { icpIds: [ICP_A], sizeCap: 0 } })).ok).toBe(false);
    expect(validateCampaignPlan(validPlan({ audience: { icpIds: [ICP_A], sizeCap: 1001 } })).ok).toBe(false);
  });

  it('拒绝 motions 引用不在 audience 的 ICP', () => {
    const result = validateCampaignPlan(validPlan({ motions: [{ type: 'discovery', icpIds: [ICP_B] }] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path.startsWith('motions'))).toBe(true);
    }
  });

  it('拒绝 schedule 顺序颠倒', () => {
    const result = validateCampaignPlan(
      validPlan({
        schedule: { notBefore: '2026-12-02T00:00:00Z', notAfter: '2026-12-01T00:00:00Z' },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('拒绝非 discovery motion 与未知字段值', () => {
    const result = validateCampaignPlan(validPlan({ motions: [{ type: 'outreach', icpIds: [ICP_A] }] }));
    expect(result.ok).toBe(false);
  });

  it('JSON Schema 导出可用', () => {
    const schema = campaignPlanV0JsonSchema();
    expect(schema).toBeTypeOf('object');
    expect(JSON.stringify(schema)).toContain('schemaVersion');
  });
});

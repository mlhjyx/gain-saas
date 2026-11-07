import { CAMPAIGN_PLAN_SCHEMA_VERSION } from './campaign-plan.schema.js';

export const ICP_A = '11111111-1111-4111-8111-111111111111';
export const ICP_B = '22222222-2222-4222-8222-222222222222';

export function validPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: CAMPAIGN_PLAN_SCHEMA_VERSION,
    goal: { objective: '在德国与美国验证吸塑包装买家' },
    audience: { icpIds: [ICP_A], sizeCap: 50 },
    motions: [{ type: 'discovery', icpIds: [ICP_A] }],
    budget: { capMicros: 1000, currency: 'USD' },
    approvalPolicy: { required: true },
    decisionPolicy: { maxReplans: 0 },
    ...overrides,
  };
}

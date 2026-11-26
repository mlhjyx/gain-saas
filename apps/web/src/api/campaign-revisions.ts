import type { CampaignRevisionView } from '#/api/gainos';

import { requestClient } from '#/api/request';

export interface ManualCampaignRevisionInput {
  schemaVersion: 'campaign-plan/v0';
  goal: {
    objective: string;
    successMetric?: string;
  };
  audience: {
    icpIds: string[];
    sizeCap: number;
  };
  motions: Array<{
    type: 'discovery';
    icpIds: string[];
  }>;
  budget: {
    capMicros?: number;
    currency: 'USD';
  };
  approvalPolicy: {
    required: true;
  };
  decisionPolicy: {
    maxReplans: 0 | 1 | 2;
  };
}

/** 人工提交一版严格符合 campaignPlanV0Schema 的战役计划草稿。 */
export function createCampaignRevision(
  campaignId: string,
  plan: ManualCampaignRevisionInput,
): Promise<CampaignRevisionView> {
  return requestClient.post<CampaignRevisionView>(
    `/campaigns/${encodeURIComponent(campaignId)}/revisions`,
    plan,
  );
}

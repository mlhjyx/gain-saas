import { z } from 'zod';

/** CampaignPlan v0 契约版本：不兼容变更 = 新版本号并存双校验器一个发布周期。 */
export const CAMPAIGN_PLAN_SCHEMA_VERSION = 'campaign-plan/v0' as const;

const isoDateTime = z.string().datetime({ offset: true });

/**
 * CampaignPlan v0（「计划即数据」）：M2.0 契约，见
 * docs/technical/campaign-control-plane-m2-0.md §4。LLM 不参与本层校验；
 * 语义校验（ICP 权属、预算上限）在 CampaignService。
 */
export const campaignPlanV0Schema = z
  .object({
    schemaVersion: z.literal(CAMPAIGN_PLAN_SCHEMA_VERSION),
    goal: z.object({
      objective: z.string().min(1).max(500),
      successMetric: z.string().max(200).optional(),
    }),
    audience: z.object({
      icpIds: z.array(z.uuid()).min(1).max(20),
      includeFilters: z.record(z.string(), z.unknown()).optional(),
      excludeFilters: z.record(z.string(), z.unknown()).optional(),
      sizeCap: z.number().int().min(1).max(1000),
    }),
    motions: z
      .array(
        z.object({
          // v0 仅 discovery；发送类动作在受控触达（步 11）之后再进枚举。
          type: z.literal('discovery'),
          icpIds: z.array(z.uuid()).min(1).max(20),
        }),
      )
      .min(1)
      .max(5),
    budget: z.object({
      capMicros: z.number().int().min(0).optional(),
      currency: z.literal('USD'),
    }),
    schedule: z
      .object({
        notBefore: isoDateTime.optional(),
        notAfter: isoDateTime.optional(),
      })
      .optional(),
    approvalPolicy: z.object({ required: z.literal(true) }),
    // M2.2：有界重规划把 maxReplans 从恒 0 扩为 {0,1,2}（向后兼容——旧计划 0 仍合法，
    // canonical JSON / plan_hash 语义不变；重规划循环与 job 成本上限在引擎侧 M2.2-1）。
    decisionPolicy: z.object({
      maxReplans: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    }),
  })
  .superRefine((plan, ctx) => {
    const audience = new Set(plan.audience.icpIds);
    plan.motions.forEach((motion, index) => {
      for (const icpId of motion.icpIds) {
        if (!audience.has(icpId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['motions', index, 'icpIds'],
            message: `ICP ${icpId} 不在 audience.icpIds 内`,
          });
        }
      }
    });
    const { notBefore, notAfter } = plan.schedule ?? {};
    if (notBefore && notAfter && notBefore >= notAfter) {
      ctx.addIssue({ code: 'custom', path: ['schedule'], message: 'notBefore 必须早于 notAfter' });
    }
  });

export type CampaignPlanV0 = z.infer<typeof campaignPlanV0Schema>;

export interface CampaignPlanIssue {
  path: string;
  message: string;
}

export type CampaignPlanValidation =
  | { ok: true; plan: CampaignPlanV0 }
  | { ok: false; issues: CampaignPlanIssue[] };

export function validateCampaignPlan(input: unknown): CampaignPlanValidation {
  const result = campaignPlanV0Schema.safeParse(input);
  if (result.success) return { ok: true, plan: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

/** JSON Schema（zod 原生导出），供外部校验与文档使用。 */
export function campaignPlanV0JsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(campaignPlanV0Schema, { io: 'input' }) as Record<string, unknown>;
}

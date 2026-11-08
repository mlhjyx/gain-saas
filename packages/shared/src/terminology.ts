/**
 * 界面用语映射(PRD §14.2 旧表,保留兼容)。
 *
 * @deprecated M2 步 14 起,对象/状态词表以 ./glossary.ts 为唯一真值
 * (run→挖掘任务、ICP→目标客户画像、campaign→战役计划、QGO→商机)。
 * 新代码一律从 glossary 取词;本文件不再新增词条。
 */

export interface Term {
  /** 界面用语 */
  readonly zh: string;
  /** 使用场景说明(给开发者,不进界面) */
  readonly note: string;
}

export const TERMINOLOGY = {
  icp: { zh: '目标客户画像', note: '引擎 ICP;旧词「目标买家」已并入 glossary' },
  queryPlan: { zh: '寻源方案', note: '引擎 Query Plan' },
  discoveryRun: { zh: '挖掘任务', note: '引擎 DiscoveryRun;状态词以 glossary RUN_STATUS 为准' },
  runRunning: { zh: '进行中', note: 'run 状态' },
  runPartial: { zh: '部分完成', note: '引擎 PARTIAL' },
  runFailed: { zh: '未完成', note: '引擎 FAILED' },
  runCompleted: { zh: '已完成', note: '引擎 COMPLETED' },
  lead: { zh: '买家线索', note: '引擎 Lead' },
  queueReview: { zh: '待我判断', note: '引擎 REVIEW 队列,默认队列' },
  queueQualified: { zh: '值得跟进', note: '引擎 QUALIFIED' },
  queueRejected: { zh: '已排除', note: '引擎 REJECTED' },
  queueSuppressed: { zh: '禁联', note: '引擎 SUPPRESSED,不可联系' },
  accept: { zh: '值得跟进', note: '裁决按钮' },
  reject: { zh: '暂不跟进', note: '裁决按钮,必选原因' },
  leadPackage: { zh: '线索档案包', note: '引擎 LeadQualifiedPackage' },
  sanctionsHold: { zh: '合规待核', note: '引擎 sanctions hold,仅管理员可见' },
  suppression: { zh: '禁联名单', note: '引擎 Suppression' },
  completeness: { zh: '档案完整度', note: '引擎 completeness' },
  claim: { zh: '认领', note: '引擎 claim' },
  scoreFit: { zh: '匹配度', note: '评分维度 fit' },
  scoreRole: { zh: '角色对口', note: '评分维度 role' },
  scoreIntent: { zh: '采购迹象', note: '评分维度 intent' },
  scoreQuality: { zh: '资料质量', note: '评分维度 data quality' },
  scoreReachability: { zh: '联系得上', note: '评分维度 reachability' },
  scoreEngagement: { zh: '互动', note: '评分维度 engagement' },
} as const satisfies Record<string, Term>;

export type TerminologyKey = keyof typeof TERMINOLOGY;

export function term(key: TerminologyKey): string {
  return TERMINOLOGY[key].zh;
}

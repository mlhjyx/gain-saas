/**
 * P6 词表（M2 版）：对象、状态与状态色的唯一真值。
 *
 * 依据：M2 步 14 设计 §4（docs/superpowers/plans/2026-11-08-p6-frontend-m2-step14.md）、
 * 计划 v1.5 §3.9 零术语红线、PRD §14.2 用语映射（M2 起按 Q32「公司为身份、任务为导航主轴」
 * 更新：run→挖掘任务、ICP→目标客户画像、campaign→战役计划、QGO→商机）。
 *
 * 规则：
 * - 引擎/系统术语（`engine` 字段）只允许出现在「技术详情」折叠区与开发者注释里；
 * - 前端用户可见文案一律从本文件取词，一处概念一个词；
 * - 状态不只靠颜色传义：色板（tone）+ 文案永远成对出现。
 * - 禁用词机检（scripts/lint-forbidden-terms.mjs）与 Playwright 文本扫描共用这套口径。
 */

export type GlossaryLang = 'en-US' | 'zh-CN';

/** 语义状态色：界面用 `gs-badge--<tone>`（styles/gainos.css），不按页面各造一套。 */
export type StatusTone = 'danger' | 'neutral' | 'processing' | 'success' | 'warning';

export interface GlossaryTerm {
  readonly en: string;
  /** 引擎/系统原名；只用于「技术详情」与开发者注释，不进用户可见面。 */
  readonly engine?: readonly string[];
  /** 给开发者的使用说明，不进界面。 */
  readonly note?: string;
  readonly zh: string;
}

export interface GlossaryStatus extends GlossaryTerm {
  readonly tone: StatusTone;
}

function pick(term: GlossaryTerm, lang?: GlossaryLang | string | null): string {
  return lang === 'en-US' ? term.en : term.zh;
}

/** 对象词表（非状态）。 */
export const GLOSSARY = {
  companyProfile: { zh: '公司档案', en: 'Company profile', engine: ['company profile'] },
  run: {
    zh: '挖掘任务',
    en: 'Discovery task',
    engine: ['DiscoveryRun', 'TaskRun', 'run', 'runs'],
    note: 'Run 2.0 起一个目标客户画像复用一个活动任务；单次执行称「本轮」。',
  },
  icp: {
    zh: '目标客户画像',
    en: 'Target customer profile',
    engine: ['ICP'],
    note: '2026-11-08 起替代旧词「目标买家」（PRD §14.2 旧表）。',
  },
  queryPlan: { zh: '寻源方案', en: 'Discovery plan', engine: ['QueryPlan', 'plan'] },
  campaign: { zh: '战役计划', en: 'Campaign plan', engine: ['Campaign', 'CampaignPlan'] },
  campaignRevision: {
    zh: '计划版本',
    en: 'Plan revision',
    engine: ['campaign_revision', 'revision', 'plan_hash'],
  },
  approval: { zh: '审批', en: 'Approval', engine: ['campaign_approval', 'approval'] },
  qgo: {
    zh: '商机',
    en: 'Opportunity',
    engine: ['QGO', 'Qualified Growth Opportunity'],
    note: '「值得跟进」的买家线索提升后的对象；必须带证据与下一步。',
  },
  sao: { zh: '已接受商机', en: 'Accepted opportunity', engine: ['SAO'] },
  outcome: { zh: '结果', en: 'Outcome', engine: ['opportunity_outcome', 'outcome'] },
  lead: { zh: '买家线索', en: 'Buyer lead', engine: ['Lead'] },
  leadPackage: { zh: '线索档案包', en: 'Lead package', engine: ['LeadQualifiedPackage'] },
  outreach: { zh: '触达', en: 'Outreach', engine: ['outreach'] },
  outreachBatch: { zh: '触达批次', en: 'Outreach batch', engine: ['outreach_batch'] },
  outreachDraft: { zh: '触达草稿', en: 'Outreach draft', engine: ['outreach_draft'] },
  outreachReply: { zh: '回复', en: 'Reply', engine: ['outreach_reply'] },
  suppression: { zh: '禁联名单', en: 'Do-not-contact list', engine: ['Suppression', 'DNC'] },
  sanctionsHold: { zh: '合规待核', en: 'Compliance review', engine: ['sanctions hold'] },
  completeness: { zh: '档案完整度', en: 'Profile completeness', engine: ['completeness'] },
  claim: { zh: '认领', en: 'Claim', engine: ['claim'] },
  shadowMode: {
    zh: '影子期',
    en: 'Shadow mode',
    note: '只生成计划并等待审批，不执行任何对外动作。',
  },
  willExecute: {
    zh: '将执行但不执行',
    en: 'Ready to execute — nothing is sent',
    note: '影子期横幅统一文案（全站同一句）。',
  },
  // 评分六维（PRD §14.2）
  scoreFit: { zh: '匹配度', en: 'Fit', engine: ['fit'] },
  scoreRole: { zh: '角色对口', en: 'Role', engine: ['role'] },
  scoreIntent: { zh: '采购迹象', en: 'Buying signals', engine: ['intent'] },
  scoreDemandProof: { zh: '需求证据', en: 'Demand proof', engine: ['demand_proof'] },
  scoreQuality: { zh: '资料质量', en: 'Data quality', engine: ['data_quality'] },
  scoreReachability: { zh: '联系得上', en: 'Reachability', engine: ['reachability'] },
  scoreEngagement: { zh: '互动', en: 'Engagement', engine: ['engagement'] },
} as const satisfies Record<string, GlossaryTerm>;

export type GlossaryKey = keyof typeof GLOSSARY;

/** 一级导航六项（M2 步 14 · D-14-a）。顺序即菜单顺序。 */
export const NAV = {
  workspace: { zh: '工作台', en: 'Workspace' },
  companies: { zh: '公司档案', en: 'Companies' },
  findBuyers: { zh: '找买家', en: 'Find buyers' },
  leads: { zh: '买家线索', en: 'Buyer leads' },
  growth: {
    zh: '商机与触达',
    en: 'Opportunities & outreach',
    note: '合并入口：Campaign / 商机 / 触达 三 tab（D-14-a）。',
  },
  settings: { zh: '设置', en: 'Settings' },
} as const satisfies Record<string, GlossaryTerm>;

export type NavKey = keyof typeof NAV;

/** 取对象词的界面用语。 */
export function glossaryTerm(key: GlossaryKey, lang?: GlossaryLang | string | null): string {
  return pick(GLOSSARY[key], lang);
}

/** 取一级导航用语。 */
export function navLabel(key: NavKey, lang?: GlossaryLang | string | null): string {
  return pick(NAV[key], lang);
}

/**
 * 状态词表。键 = 引擎/接口返回值（原样），值 = 界面用语 + 语义色。
 * 未登记的状态值不得直接渲染进界面（由调用方回退到中性文案或技术详情）。
 */
export const RUN_STATUS = {
  RUNNING: { zh: '进行中', en: 'Running', tone: 'processing', engine: ['RUNNING'] },
  DONE: { zh: '已完成', en: 'Completed', tone: 'success', engine: ['DONE', 'COMPLETED'] },
  PARTIAL: { zh: '部分完成', en: 'Partially completed', tone: 'warning', engine: ['PARTIAL'] },
  FAILED: { zh: '未完成', en: 'Did not finish', tone: 'danger', engine: ['FAILED'] },
  CANCELLED: { zh: '已停止', en: 'Stopped', tone: 'neutral', engine: ['CANCELLED'] },
} as const satisfies Record<string, GlossaryStatus>;

export const ICP_STATUS = {
  DRAFT: { zh: '初稿', en: 'Draft', tone: 'warning', engine: ['DRAFT'] },
  HYPOTHESIS: { zh: '假设', en: 'Hypothesis', tone: 'warning', engine: ['HYPOTHESIS'] },
  VALIDATING: { zh: '验证中', en: 'Validating', tone: 'processing', engine: ['VALIDATING'] },
  ACTIVE: { zh: '生效中', en: 'Active', tone: 'success', engine: ['ACTIVE'] },
  SUPERSEDED: { zh: '已被取代', en: 'Superseded', tone: 'neutral', engine: ['SUPERSEDED'] },
  ARCHIVED: { zh: '已归档', en: 'Archived', tone: 'neutral', engine: ['ARCHIVED'] },
} as const satisfies Record<string, GlossaryStatus>;

/** 买家线索队列（BFF 队列键）。 */
export const LEAD_QUEUE = {
  needs_review: {
    zh: '待我判断',
    en: 'To review',
    tone: 'processing',
    engine: ['REVIEW', 'needs_review'],
  },
  recommended: {
    zh: '值得跟进',
    en: 'Worth following up',
    tone: 'success',
    engine: ['QUALIFIED', 'recommended'],
  },
  rejected: { zh: '已排除', en: 'Excluded', tone: 'neutral', engine: ['REJECTED', 'rejected'] },
  suppressed: {
    zh: '禁联',
    en: 'Do not contact',
    tone: 'warning',
    engine: ['SUPPRESSED', 'suppressed'],
  },
  sanctions_hold: {
    zh: '合规待核',
    en: 'Compliance review',
    tone: 'warning',
    engine: ['sanctions_hold'],
  },
} as const satisfies Record<string, GlossaryStatus>;

export const CAMPAIGN_STATUS = {
  DRAFT: { zh: '草稿', en: 'Draft', tone: 'neutral', engine: ['DRAFT'] },
  ACTIVE: { zh: '进行中', en: 'Active', tone: 'processing', engine: ['ACTIVE'] },
  PAUSED: { zh: '已暂停', en: 'Paused', tone: 'warning', engine: ['PAUSED'] },
  ARCHIVED: { zh: '已归档', en: 'Archived', tone: 'neutral', engine: ['ARCHIVED'] },
} as const satisfies Record<string, GlossaryStatus>;

export const APPROVAL_STATE = {
  PENDING: { zh: '待审批', en: 'Pending approval', tone: 'processing', engine: ['PENDING'] },
  APPROVED: { zh: '已批准', en: 'Approved', tone: 'success', engine: ['APPROVED'] },
  DECLINED: { zh: '已拒绝', en: 'Declined', tone: 'danger', engine: ['DECLINED'] },
  EXPIRED: { zh: '已过期', en: 'Expired', tone: 'neutral', engine: ['EXPIRED'] },
} as const satisfies Record<string, GlossaryStatus>;

export const REVISION_STATE = {
  ...APPROVAL_STATE,
  SUBMITTED: { zh: '待审批', en: 'Submitted', tone: 'processing', engine: ['SUBMITTED'] },
  SUPERSEDED: {
    zh: '已被新版本取代',
    en: 'Superseded',
    tone: 'neutral',
    engine: ['SUPERSEDED'],
  },
} as const satisfies Record<string, GlossaryStatus>;

export const QGO_STATE = {
  OPEN: { zh: '待推进', en: 'Open', tone: 'processing', engine: ['OPEN'] },
  CONVERTED: { zh: '已转化', en: 'Converted', tone: 'success', engine: ['CONVERTED'] },
  DROPPED: { zh: '已放弃', en: 'Dropped', tone: 'neutral', engine: ['DROPPED'] },
} as const satisfies Record<string, GlossaryStatus>;

export const SAO_STATE = {
  ACCEPTED: { zh: '已接受', en: 'Accepted', tone: 'success', engine: ['ACCEPTED'] },
  DECLINED: { zh: '已拒绝', en: 'Declined', tone: 'neutral', engine: ['DECLINED'] },
} as const satisfies Record<string, GlossaryStatus>;

export const OUTCOME_STATE = {
  REPLIED: { zh: '已回复', en: 'Replied', tone: 'processing', engine: ['REPLIED'] },
  MEETING_BOOKED: {
    zh: '已约会议',
    en: 'Meeting booked',
    tone: 'success',
    engine: ['MEETING_BOOKED'],
  },
  QUOTE_SENT: { zh: '已报价', en: 'Quote sent', tone: 'success', engine: ['QUOTE_SENT'] },
  WON: { zh: '赢单', en: 'Won', tone: 'success', engine: ['WON'] },
  LOST: { zh: '丢单', en: 'Lost', tone: 'danger', engine: ['LOST'] },
  NO_RESPONSE: { zh: '未回复', en: 'No response', tone: 'neutral', engine: ['NO_RESPONSE'] },
  DISQUALIFIED: {
    zh: '不符合',
    en: 'Disqualified',
    tone: 'neutral',
    engine: ['DISQUALIFIED'],
  },
} as const satisfies Record<string, GlossaryStatus>;

export const OUTREACH_SEND_STATUS = {
  SENT: { zh: '已发送', en: 'Sent', tone: 'success', engine: ['SENT'] },
  BOUNCED: { zh: '退信', en: 'Bounced', tone: 'danger', engine: ['BOUNCED'] },
  COMPLAINED: { zh: '投诉', en: 'Complained', tone: 'danger', engine: ['COMPLAINED'] },
} as const satisfies Record<string, GlossaryStatus>;

/** 触达批次状态（M2 步 11-2）。 */
export const OUTREACH_BATCH_STATUS = {
  DRAFT: { zh: '草稿', en: 'Draft', tone: 'neutral', engine: ['DRAFT'] },
  PENDING_APPROVAL: {
    zh: '待审批',
    en: 'Pending approval',
    tone: 'warning',
    engine: ['PENDING_APPROVAL'],
  },
  APPROVED: { zh: '已批准', en: 'Approved', tone: 'success', engine: ['APPROVED'] },
  DECLINED: { zh: '已拒绝', en: 'Declined', tone: 'danger', engine: ['DECLINED'] },
  EXPIRED: { zh: '已过期', en: 'Expired', tone: 'neutral', engine: ['EXPIRED'] },
  QUEUED: { zh: '待发送', en: 'Queued', tone: 'processing', engine: ['QUEUED'] },
  SENT: { zh: '已发送', en: 'Sent', tone: 'success', engine: ['SENT'] },
  COMPLETED: { zh: '已完成', en: 'Completed', tone: 'success', engine: ['COMPLETED'] },
  CANCELLED: { zh: '已取消', en: 'Cancelled', tone: 'neutral', engine: ['CANCELLED'] },
} as const satisfies Record<string, GlossaryStatus>;

/** 触达草稿状态（M2 步 11-2/11-3）。 */
export const OUTREACH_DRAFT_STATUS = {
  DRAFT: { zh: '草稿', en: 'Draft', tone: 'neutral', engine: ['DRAFT'] },
  PENDING_APPROVAL: {
    zh: '待审批',
    en: 'Pending approval',
    tone: 'warning',
    engine: ['PENDING_APPROVAL'],
  },
  APPROVED: { zh: '已批准', en: 'Approved', tone: 'success', engine: ['APPROVED'] },
  REJECTED: { zh: '已拒绝', en: 'Rejected', tone: 'danger', engine: ['REJECTED'] },
  SKIPPED: { zh: '已跳过', en: 'Skipped', tone: 'neutral', engine: ['SKIPPED'] },
  SENT: { zh: '已发送', en: 'Sent', tone: 'success', engine: ['SENT'] },
  FAILED: { zh: '发送失败', en: 'Failed', tone: 'danger', engine: ['FAILED'] },
} as const satisfies Record<string, GlossaryStatus>;

/** 判定复核任务状态（引擎 judgment_review_task.status，P3 J17）。 */
export const REVIEW_TASK_STATUS = {
  queued: { zh: '待认领', en: 'To claim', tone: 'warning', engine: ['queued'] },
  in_review: { zh: '复核中', en: 'In review', tone: 'processing', engine: ['in_review'] },
  resolved: { zh: '已复核', en: 'Reviewed', tone: 'success', engine: ['resolved'] },
  expired: { zh: '已过期', en: 'Expired', tone: 'neutral', engine: ['expired'] },
} as const satisfies Record<string, GlossaryStatus>;

/** 复核优先级（引擎为 0–3，界面按 P0–P3 展示；SLA 用 dueAt 现算）。 */
export const REVIEW_PRIORITY = {
  '0': { zh: 'P0 紧急', en: 'P0 urgent', tone: 'danger', engine: ['0'] },
  '1': { zh: 'P1 高', en: 'P1 high', tone: 'warning', engine: ['1'] },
  '2': { zh: 'P2 常规', en: 'P2 normal', tone: 'processing', engine: ['2'] },
  '3': { zh: 'P3 低', en: 'P3 low', tone: 'neutral', engine: ['3'] },
} as const satisfies Record<string, GlossaryStatus>;

/** 复核任务来源（引擎 judgment_review_task.reason）。 */
export const REVIEW_REASON = {
  UNKNOWN: { zh: '机器无法判定', en: 'No machine decision', tone: 'warning', engine: ['UNKNOWN'] },
  BORDERLINE: { zh: '边界案例', en: 'Borderline', tone: 'warning', engine: ['BORDERLINE'] },
  RANDOM_AUDIT: { zh: '随机抽检', en: 'Random audit', tone: 'processing', engine: ['RANDOM_AUDIT'] },
  DRIFT_AUDIT: { zh: '标准漂移审计', en: 'Rubric drift audit', tone: 'neutral', engine: ['DRIFT_AUDIT'] },
  APPEAL: { zh: '申诉复核', en: 'Appeal', tone: 'neutral', engine: ['APPEAL'] },
  CONFORMAL_ABSTAIN: {
    zh: '模型置信度不足',
    en: 'Low confidence',
    tone: 'warning',
    engine: ['CONFORMAL_ABSTAIN'],
  },
} as const satisfies Record<string, GlossaryStatus>;

/** 判定结论（引擎 verdict：机器判定与人工复核共用）。 */
export const REVIEW_VERDICT = {
  FIT: { zh: '符合', en: 'Fits', tone: 'success', engine: ['FIT'] },
  NOT_FIT: { zh: '不符合', en: 'Does not fit', tone: 'danger', engine: ['NOT_FIT'] },
  UNKNOWN: { zh: '无法判断', en: 'Unclear', tone: 'neutral', engine: ['UNKNOWN'] },
} as const satisfies Record<string, GlossaryStatus>;

/** 判据评分档（引擎 fit-v2 rubric 的 criterion.label）。 */
export const REVIEW_CRITERION_LABEL = {
  pass: { zh: '符合', en: 'Pass', tone: 'success', engine: ['pass'] },
  weak: { zh: '偏弱', en: 'Weak', tone: 'warning', engine: ['weak'] },
  fail: { zh: '不符', en: 'Fail', tone: 'danger', engine: ['fail'] },
  unclear: { zh: '证据不足', en: 'Unclear', tone: 'neutral', engine: ['unclear'] },
  not_applicable: {
    zh: '不适用',
    en: 'Not applicable',
    tone: 'neutral',
    engine: ['not_applicable'],
  },
} as const satisfies Record<string, GlossaryStatus>;

/** 指标字典状态（引擎 metric_definition.status）。 */
export const METRIC_STATUS = {
  ACTIVE: { zh: '生效中', en: 'Active', tone: 'success', engine: ['ACTIVE'] },
  DRAFT: { zh: '草稿', en: 'Draft', tone: 'warning', engine: ['DRAFT'] },
  DEPRECATED: { zh: '已弃用', en: 'Deprecated', tone: 'neutral', engine: ['DEPRECATED'] },
  RETIRED: { zh: '已停用', en: 'Retired', tone: 'neutral', engine: ['RETIRED'] },
} as const satisfies Record<string, GlossaryStatus>;

export const STATUS_TABLES = {
  run: RUN_STATUS,
  icp: ICP_STATUS,
  leadQueue: LEAD_QUEUE,
  campaign: CAMPAIGN_STATUS,
  approval: APPROVAL_STATE,
  revision: REVISION_STATE,
  qgo: QGO_STATE,
  sao: SAO_STATE,
  outcome: OUTCOME_STATE,
  outreachSend: OUTREACH_SEND_STATUS,
  outreachBatch: OUTREACH_BATCH_STATUS,
  outreachDraft: OUTREACH_DRAFT_STATUS,
  reviewTask: REVIEW_TASK_STATUS,
  reviewPriority: REVIEW_PRIORITY,
  reviewReason: REVIEW_REASON,
  reviewVerdict: REVIEW_VERDICT,
  criterionLabel: REVIEW_CRITERION_LABEL,
  metricStatus: METRIC_STATUS,
} as const;

export type StatusDomain = keyof typeof STATUS_TABLES;

/** 状态类名（styles/gainos.css 的 gs-badge--*）。 */
export function statusClass(tone: StatusTone): string {
  return `gs-badge--${tone}`;
}

/**
 * 按域取状态文案与色板。未登记的值返回 null——调用方不得把原始枚举直接写进界面，
 * 需要展示时收进「技术详情」折叠区。
 */
export function glossaryStatus(
  domain: StatusDomain,
  value: null | string | undefined,
  lang?: GlossaryLang | string | null,
): { label: string; tone: StatusTone } | null {
  if (!value) return null;
  const table = STATUS_TABLES[domain] as Record<string, GlossaryStatus>;
  const entry = table[value];
  if (!entry) return null;
  return { label: pick(entry, lang), tone: entry.tone };
}

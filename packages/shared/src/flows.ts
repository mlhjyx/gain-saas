/**
 * 四条业务流转的显式状态机（v3.0 ch07 关键决策二）。
 *
 * 页面只消费 `derive*Actions` 的结果来渲染按钮与下一步，
 * 不再各自维护 nextAction 的分支链（审计：同一状态在四个页面有四种解释）。
 * 纯函数、无依赖：可被 web / server / 测试共用。
 */

export type RunStatus = 'RUNNING' | 'DONE' | 'PARTIAL' | 'FAILED' | 'CANCELLED';

export interface RunActionResult {
  canStop: boolean;
  canRetry: boolean;
  canViewLeads: boolean;
  /** 页面「下一步」主按钮。wait = 运行中等待，不需要用户操作。 */
  primary: 'stop' | 'retry' | 'viewLeads' | 'wait';
}

export interface RunActionInput {
  status?: string | null;
  /** 有可重试的计划（task/plan 上下文齐全）。 */
  retriable?: boolean;
  /** 本轮已产出线索。 */
  hasLeads?: boolean;
}

export function deriveRunActions(input: RunActionInput): RunActionResult {
  const status = (input.status ?? 'RUNNING') as RunStatus;
  switch (status) {
    case 'RUNNING':
      return { canStop: true, canRetry: false, canViewLeads: false, primary: 'wait' };
    case 'PARTIAL':
      return {
        canStop: false,
        canRetry: Boolean(input.retriable),
        canViewLeads: Boolean(input.hasLeads),
        primary: input.hasLeads ? 'viewLeads' : input.retriable ? 'retry' : 'wait',
      };
    case 'DONE':
      return { canStop: false, canRetry: false, canViewLeads: Boolean(input.hasLeads), primary: input.hasLeads ? 'viewLeads' : 'wait' };
    case 'FAILED':
    case 'CANCELLED':
      return {
        canStop: false,
        canRetry: Boolean(input.retriable),
        canViewLeads: Boolean(input.hasLeads),
        primary: input.retriable ? 'retry' : 'wait',
      };
    default:
      return { canStop: false, canRetry: false, canViewLeads: false, primary: 'wait' };
  }
}

export type CampaignRevisionState = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'DECLINED' | 'EXPIRED' | 'SUPERSEDED';

export interface CampaignActionResult {
  canSubmit: boolean;
  canApprove: boolean;
  canDecline: boolean;
  canNewRevision: boolean;
  canGoOutreach: boolean;
  primary: 'submit' | 'approve' | 'newRevision' | 'goOutreach' | 'wait';
}

export interface CampaignActionInput {
  revisionState?: string | null;
  /** 有待决审批（SUBMITTED 且 approval PENDING）。 */
  pendingApproval?: boolean;
}

export function deriveCampaignActions(input: CampaignActionInput): CampaignActionResult {
  const state = (input.revisionState ?? 'DRAFT') as CampaignRevisionState;
  const pending = Boolean(input.pendingApproval);
  switch (state) {
    case 'DRAFT':
      return { canSubmit: true, canApprove: false, canDecline: false, canNewRevision: false, canGoOutreach: false, primary: 'submit' };
    case 'SUBMITTED':
      return {
        canSubmit: false,
        canApprove: pending,
        canDecline: pending,
        canNewRevision: false,
        canGoOutreach: false,
        primary: pending ? 'approve' : 'wait',
      };
    case 'APPROVED':
      return { canSubmit: false, canApprove: false, canDecline: false, canNewRevision: false, canGoOutreach: true, primary: 'goOutreach' };
    case 'DECLINED':
    case 'EXPIRED':
      return { canSubmit: false, canApprove: false, canDecline: false, canNewRevision: true, canGoOutreach: false, primary: 'newRevision' };
    case 'SUPERSEDED':
      return { canSubmit: false, canApprove: false, canDecline: false, canNewRevision: false, canGoOutreach: false, primary: 'wait' };
    default:
      return { canSubmit: false, canApprove: false, canDecline: false, canNewRevision: false, canGoOutreach: false, primary: 'wait' };
  }
}

export type OutreachBatchState =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'QUEUED'
  | 'SENT'
  | 'COMPLETED'
  | 'CANCELLED';

export interface OutreachActionResult {
  canAddDraft: boolean;
  canSubmit: boolean;
  canApprove: boolean;
  canDecline: boolean;
  canViewReplies: boolean;
  primary: 'addDraft' | 'submit' | 'approve' | 'viewReplies' | 'wait';
}

export interface OutreachActionInput {
  status?: string | null;
  /** 批次里已有草稿数。 */
  draftCount?: number;
}

/**
 * 发送通道默认关闭：APPROVED/QUEUED 的下一步是「等待发送通道开放」，
 * 不提供任何发送按钮（M2 步 11 的硬约束）。
 */
export function deriveOutreachActions(input: OutreachActionInput): OutreachActionResult {
  const status = (input.status ?? 'DRAFT') as OutreachBatchState;
  const drafts = Number(input.draftCount ?? 0);
  switch (status) {
    case 'DRAFT':
      return {
        canAddDraft: true,
        canSubmit: drafts > 0,
        canApprove: false,
        canDecline: false,
        canViewReplies: false,
        primary: drafts > 0 ? 'submit' : 'addDraft',
      };
    case 'PENDING_APPROVAL':
      return { canAddDraft: false, canSubmit: false, canApprove: true, canDecline: true, canViewReplies: false, primary: 'approve' };
    case 'APPROVED':
    case 'QUEUED':
      return { canAddDraft: false, canSubmit: false, canApprove: false, canDecline: false, canViewReplies: false, primary: 'wait' };
    case 'SENT':
    case 'COMPLETED':
      return { canAddDraft: false, canSubmit: false, canApprove: false, canDecline: false, canViewReplies: true, primary: 'viewReplies' };
    case 'DECLINED':
    case 'EXPIRED':
    case 'CANCELLED':
      return { canAddDraft: false, canSubmit: false, canApprove: false, canDecline: false, canViewReplies: false, primary: 'wait' };
    default:
      return { canAddDraft: false, canSubmit: false, canApprove: false, canDecline: false, canViewReplies: false, primary: 'wait' };
  }
}

export type ReplyClassification = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'OUT_OF_OFFICE' | 'UNKNOWN';

export interface ReplyActionResult {
  /** 需要人工跟进（正面/中性且非自动回复）。 */
  needsFollowUp: boolean;
  /** 该回复是否已让后续发送自动停止（负面/退订/退信）。 */
  autoStopped: boolean;
  primary: 'followUp' | 'none';
}

export function deriveReplyActions(input: { classification?: string | null; kind?: string | null }): ReplyActionResult {
  const classification = (input.classification ?? 'UNKNOWN') as ReplyClassification;
  const kind = (input.kind ?? 'REPLY').toUpperCase();
  if (kind === 'UNSUBSCRIBE' || kind === 'BOUNCE' || classification === 'NEGATIVE') {
    return { needsFollowUp: false, autoStopped: true, primary: 'none' };
  }
  if (classification === 'OUT_OF_OFFICE') {
    return { needsFollowUp: false, autoStopped: false, primary: 'none' };
  }
  if (classification === 'POSITIVE' || classification === 'NEUTRAL') {
    return { needsFollowUp: true, autoStopped: false, primary: 'followUp' };
  }
  return { needsFollowUp: false, autoStopped: false, primary: 'none' };
}

import { describe, expect, it } from 'vitest';

import { deriveCampaignActions, deriveOutreachActions, deriveReplyActions, deriveRunActions } from './flows.js';

describe('deriveRunActions', () => {
  it('RUNNING：可停止、不可重试、主按钮=等待', () => {
    expect(deriveRunActions({ status: 'RUNNING' })).toEqual({ canStop: true, canRetry: false, canViewLeads: false, primary: 'wait' });
  });
  it('PARTIAL：有线索→主按钮看线索；无线索但可重试→重试', () => {
    expect(deriveRunActions({ status: 'PARTIAL', hasLeads: true, retriable: true }).primary).toBe('viewLeads');
    expect(deriveRunActions({ status: 'PARTIAL', hasLeads: false, retriable: true }).primary).toBe('retry');
  });
  it('FAILED：可重试则主按钮=重试', () => {
    expect(deriveRunActions({ status: 'FAILED', retriable: true }).primary).toBe('retry');
    expect(deriveRunActions({ status: 'FAILED', retriable: false }).primary).toBe('wait');
  });
  it('DONE：有线索主按钮=看线索', () => {
    expect(deriveRunActions({ status: 'DONE', hasLeads: true })).toMatchObject({ canViewLeads: true, primary: 'viewLeads' });
  });
});

describe('deriveCampaignActions', () => {
  it('DRAFT：可提交', () => {
    expect(deriveCampaignActions({ revisionState: 'DRAFT' })).toMatchObject({ canSubmit: true, primary: 'submit' });
  });
  it('SUBMITTED + 待决审批：可批准/拒绝', () => {
    expect(deriveCampaignActions({ revisionState: 'SUBMITTED', pendingApproval: true })).toMatchObject({
      canApprove: true,
      canDecline: true,
      primary: 'approve',
    });
  });
  it('APPROVED：主按钮=去触达', () => {
    expect(deriveCampaignActions({ revisionState: 'APPROVED' })).toMatchObject({ canGoOutreach: true, primary: 'goOutreach' });
  });
  it('DECLINED/EXPIRED：可新版本', () => {
    expect(deriveCampaignActions({ revisionState: 'DECLINED' }).primary).toBe('newRevision');
    expect(deriveCampaignActions({ revisionState: 'EXPIRED' }).primary).toBe('newRevision');
  });
});

describe('deriveOutreachActions', () => {
  it('DRAFT 无草稿：主按钮=加草稿；有草稿：可提交', () => {
    expect(deriveOutreachActions({ status: 'DRAFT', draftCount: 0 })).toMatchObject({ canAddDraft: true, primary: 'addDraft' });
    expect(deriveOutreachActions({ status: 'DRAFT', draftCount: 2 })).toMatchObject({ canSubmit: true, primary: 'submit' });
  });
  it('PENDING_APPROVAL：可批准/拒绝', () => {
    expect(deriveOutreachActions({ status: 'PENDING_APPROVAL' })).toMatchObject({ canApprove: true, canDecline: true, primary: 'approve' });
  });
  it('APPROVED/QUEUED：等待发送通道，无任何发送动作', () => {
    const actions = deriveOutreachActions({ status: 'APPROVED' });
    expect(actions.primary).toBe('wait');
    expect(actions.canApprove || actions.canSubmit || actions.canAddDraft).toBe(false);
  });
  it('SENT/COMPLETED：可看回复', () => {
    expect(deriveOutreachActions({ status: 'SENT' }).primary).toBe('viewReplies');
  });
});

describe('deriveReplyActions', () => {
  it('正面/中性：需要跟进', () => {
    expect(deriveReplyActions({ classification: 'POSITIVE' })).toMatchObject({ needsFollowUp: true, primary: 'followUp' });
    expect(deriveReplyActions({ classification: 'NEUTRAL' }).needsFollowUp).toBe(true);
  });
  it('负面/退订/退信：自动停止，无需跟进', () => {
    expect(deriveReplyActions({ classification: 'NEGATIVE' })).toMatchObject({ autoStopped: true, primary: 'none' });
    expect(deriveReplyActions({ classification: 'POSITIVE', kind: 'UNSUBSCRIBE' })).toMatchObject({ autoStopped: true });
    expect(deriveReplyActions({ kind: 'BOUNCE' })).toMatchObject({ autoStopped: true });
  });
  it('自动回复：不跟进也不停止', () => {
    expect(deriveReplyActions({ classification: 'OUT_OF_OFFICE' })).toMatchObject({ needsFollowUp: false, autoStopped: false });
  });
});

import { createHash } from 'node:crypto';

export interface OutreachHashableDraft {
  contactRef: string;
  recipientEmail: string;
  subject: string;
  body: string;
}

/**
 * 批次审批的内容哈希（M2 步 11-2）：按联系人排序后序列化全部草稿。
 * 11-3 发送前重新计算，与审批时记录的 contentHash 不一致即拒绝发送。
 */
export function hashOutreachDrafts(drafts: ReadonlyArray<OutreachHashableDraft>): string {
  const canonical = drafts
    .map((draft) => ({
      contactRef: draft.contactRef,
      recipientEmail: draft.recipientEmail.trim().toLowerCase(),
      subject: draft.subject,
      body: draft.body,
    }))
    .sort((left, right) =>
      left.contactRef < right.contactRef ? -1 : left.contactRef > right.contactRef ? 1 : 0,
    );
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** 单封草稿的规范化哈希（发送台账按主题/正文分别记录）。 */
export function hashDraftField(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

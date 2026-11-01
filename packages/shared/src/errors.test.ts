import { describe, expect, it } from 'vitest';
import { ENGINE_ERROR_COPY, copyForError } from './errors.js';

describe('copyForError', () => {
  it('已知码返回登记文案', () => {
    expect(copyForError('SUPPRESSED').title).toContain('禁联');
  });

  it('未知码返回可上报的 fallback,不抛错', () => {
    const copy = copyForError('SOME_FUTURE_CODE');
    expect(copy.title).toBeTruthy();
    expect(copy.next).toContain('运营');
  });

  it('PRD D6 的 409 阻断族全部有登记', () => {
    const blockers = [
      'SUPPRESSED',
      'INVALID_STATE',
      'SUPPRESSED_CONTACT_UNREACHABLE',
      'STORAGE_RIGHTS_NOT_GRANTED',
      'SANCTIONS_HOLD_UNRESOLVED',
      'CONFLICT',
    ];
    for (const code of blockers) expect(code in ENGINE_ERROR_COPY).toBe(true);
  });

  it('交付闭环的开发信草稿错误码有登记(不再落 fallback)', () => {
    expect(copyForError('OUTREACH_DRAFT_LEAD_NOT_ACCEPTED').why).toContain('接受');
    expect(copyForError('OUTREACH_DRAFT_UNGROUNDED').title).toContain('事实校验');
    expect(copyForError('OUTREACH_DRAFT_VERSION_CONFLICT').title).toContain('版本冲突');
  });

  it('联系人挖掘的合规/前置错误码有登记', () => {
    expect(copyForError('CONTACT_DISCOVERY_LAWFUL_BASIS_REQUIRED').title).toContain('合法性依据');
    expect(copyForError('NO_DOMAIN').why).toContain('域名');
    expect(copyForError('NO_PROVIDER').title).toContain('数据源');
    expect(copyForError('EXECUTION_BUDGET_AUTHORITY_REVOKED').title).toContain('撤销');
    expect(copyForError('EXECUTION_BUDGET_QUOTE_UNAVAILABLE').title).toContain('执行预算账户');
  });
});

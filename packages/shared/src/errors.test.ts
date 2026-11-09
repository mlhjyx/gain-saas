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

  it('401 家族有登记且引导重新登录,不落兜底「重试」', () => {
    for (const code of ['AUTH_REQUIRED', 'SESSION_EXPIRED']) {
      const copy = copyForError(code);
      expect(copy.title).toContain('登录已过期');
      expect(copy.next).toContain('重新登录');
    }
    expect(copyForError('NOT_A_MEMBER').next).toContain('工作空间');
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

  it('发送门（法域同意/执行授权/控制面）的错误码全部有登记', () => {
    const sendGateCodes = [
      'JURISDICTION_CONSENT_REQUIRED',
      'JURISDICTION_REVIEW_REQUIRED',
      'JURISDICTION_US_POSTAL_ADDRESS_REQUIRED',
      'JURISDICTION_FR_SOURCE_NOTICE_REQUIRED',
      'OUTREACH_WINDOW_CLOSED',
      'OUTREACH_MAILBOX_DAILY_CAP',
      'OUTREACH_MAILBOX_WEEKLY_CAP',
      'OUTREACH_DOMAIN_RATE_LIMITED',
      'OUTREACH_MAILBOX_PAUSED',
      'OUTREACH_DOMAIN_PAUSED',
      'OUTREACH_AUTHORIZATION_SCOPE_MISMATCH',
      'OUTREACH_SCHEDULE_OUT_OF_WINDOW',
      'OUTREACH_BUDGET_EXCEEDED',
      'CAMPAIGN_AUTHORIZATION_USES_EXHAUSTED',
      'CAMPAIGN_AUTHORIZATION_INVALID',
      'CAMPAIGN_AUTHORIZATION_REVOKED',
      'CAMPAIGN_AUTHORIZATION_EXPIRED',
      'OUTREACH_BATCH_SIZE_EXCEEDED',
      'OUTREACH_MAILBOX_NOT_FOUND',
      'OUTREACH_MAILBOX_DUPLICATE',
      'OUTREACH_DOMAIN_NOT_FOUND',
      'OUTREACH_HALF_OPEN_CAP',
      'OUTREACH_BREAKER_NOT_FOUND',
      'OUTREACH_BREAKER_NOT_OPEN',
      'OUTREACH_BREAKER_NOT_HALF_OPEN',
    ] as const;
    for (const code of sendGateCodes) {
      expect(code in ENGINE_ERROR_COPY, `${code} 未登记`).toBe(true);
    }
    expect(copyForError('JURISDICTION_CONSENT_REQUIRED', 'en').title).toContain('consent');
  });

  it('联系人挖掘的合规/前置错误码有登记', () => {
    expect(copyForError('CONTACT_DISCOVERY_LAWFUL_BASIS_REQUIRED').title).toContain('合法性依据');
    expect(copyForError('NO_DOMAIN').why).toContain('域名');
    expect(copyForError('NO_PROVIDER').title).toContain('数据源');
    expect(copyForError('EXECUTION_BUDGET_AUTHORITY_REVOKED').title).toContain('撤销');
    expect(copyForError('EXECUTION_BUDGET_QUOTE_UNAVAILABLE').title).toContain('执行预算账户');
  });

  it('P5 高频码（租户/引导/档案）全部有登记(不再落 fallback)', () => {
    const p5Codes = [
      'NO_APPROVED_CLAIMS',
      'WORKSPACE_DISABLED',
      'ONBOARDING_INCOMPLETE',
      'RATE_LIMITED',
      'EMAIL_TAKEN',
      'ALREADY_MEMBER',
      'FORBIDDEN',
      'NOT_A_MEMBER',
      'LAST_ADMIN',
      'LAST_MEMBER',
      'VERSION_CONFLICT',
      'UNDERSTANDING_WEBSITE_REQUIRED',
      'UNDERSTANDING_ALREADY_PENDING',
      'UNDERSTANDING_RETRY_NOT_ALLOWED',
      'COMPANY_NOT_DELETABLE',
      'INVALID_URL',
      'INVITE_INVALID',
      'SANCTIONS_CONFIRMED_IMMUTABLE',
      'INTERNAL',
    ];
    for (const code of p5Codes) {
      expect(ENGINE_ERROR_COPY[code as keyof typeof ENGINE_ERROR_COPY], `${code} 未登记`).toBeTruthy();
    }
    expect(copyForError('NO_APPROVED_CLAIMS').next).toContain('事实');
    expect(copyForError('WORKSPACE_DISABLED').title).toContain('停用');
  });

  it('表内每条文案三层齐全、无空白占位', () => {
    for (const [code, copy] of Object.entries(ENGINE_ERROR_COPY)) {
      expect(copy.title.trim(), `${code}.title`).not.toBe('');
      expect(copy.why.trim(), `${code}.why`).not.toBe('');
      expect(copy.next.trim(), `${code}.next`).not.toBe('');
    }
  });
});

describe('商机域错误码（M2 步 10）', () => {
  it('QGO 证据门 / 线索未接受 / 结果枚举 都有三层文案', () => {
    expect(copyForError('QGO_EVIDENCE_REQUIRED').title).toContain('证据');
    expect(copyForError('LEAD_NOT_QUALIFIED').title).toContain('已接受');
    expect(copyForError('INVALID_OUTCOME').title).toContain('结果');
  });
});

describe('copyForError 英文词表', () => {
  it('en 请求返回英文三层文案，缺省回落中文', async () => {
    const { copyForError } = await import('./errors.js');
    const en = copyForError('WORKSPACE_DISABLED', 'en-US');
    expect(en.title).toContain('disabled');
    expect(en.why.length).toBeGreaterThan(10);
    const zh = copyForError('WORKSPACE_DISABLED');
    expect(zh.title).toBe('当前工作空间已停用');
    // Accept-Language 形如 "en-US,en;q=0.9"
    expect(copyForError('WORKSPACE_DISABLED', 'en-US,en;q=0.9').title).toContain('disabled');
  });

  it('全部词条都有英文（en 界面不再回落中文）', async () => {
    const mod = await import('./errors.js');
    const codes = Object.keys(mod.ENGINE_ERROR_COPY) as Array<keyof typeof mod.ENGINE_ERROR_COPY>;
    const missing = codes.filter((code) => !mod.ENGINE_ERROR_COPY[code].en);
    expect(missing).toEqual([]);
  });
});

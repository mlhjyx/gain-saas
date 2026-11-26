import { describe, expect, it } from 'vitest';

import {
  evaluateDomainDnsAdvice,
  extractReferredContacts,
  insertIcebreakerIntoBody,
  mapRejectCodeToFeedbackReason,
  normalizeIcebreakerSuggestions,
  normalizeIcpFeedbackSummary,
  planT1FollowUpSequence,
  validateT1Attachments,
} from './outreach-t1.js';

describe('planT1FollowUpSequence', () => {
  const baseInput = {
    companyName: 'SolarGrid Italia S.r.l.',
    countryCode: 'IT',
    subject: 'HJT 700W PV Module Supply for Italy',
    body: 'Hello team, we manufacture HJT modules in stock for EU distributors.',
    rounds: 4,
    startAt: '2026-11-26T08:00:00.000Z',
  };

  it('builds a 4-round Day 0/3/7/14 sequence when compliant and no stop signal', () => {
    const plan = planT1FollowUpSequence(baseInput);
    expect(plan.stopped).toBe(false);
    expect(plan.stopReason).toBeNull();
    expect(plan.steps).toHaveLength(4);
    expect(plan.steps.map((s) => s.dayOffset)).toEqual([0, 3, 7, 14]);
    expect(plan.steps.every((s) => s.status === 'scheduled')).toBe(true);
    expect(plan.steps[1]?.subject).toContain('Re:');
  });

  it('hard-stops remaining rounds immediately on any human reply (even POSITIVE)', () => {
    const plan = planT1FollowUpSequence({
      ...baseInput,
      sentRounds: 1,
      events: [{ kind: 'REPLY', classification: 'POSITIVE', receivedAt: '2026-11-27T09:00:00.000Z' }],
    });
    expect(plan.stopped).toBe(true);
    expect(plan.stopReason).toBe('REPLY_RECEIVED');
    expect(plan.steps[0]?.status).toBe('sent');
    expect(plan.steps.slice(1).every((s) => s.status === 'stopped')).toBe(true);
  });

  it('hard-stops on OPT_OUT / UNSUBSCRIBE / BOUNCE / SUPPRESSED', () => {
    const optOut = planT1FollowUpSequence({ ...baseInput, consentStatus: 'OPT_OUT' });
    expect(optOut.stopped).toBe(true);
    expect(optOut.stopReason).toBe('OPT_OUT');
    expect(optOut.steps.every((s) => s.status === 'stopped')).toBe(true);

    const bounced = planT1FollowUpSequence({
      ...baseInput,
      sentRounds: 1,
      events: [{ kind: 'BOUNCE', classification: 'UNKNOWN' }],
    });
    expect(bounced.stopped).toBe(true);
    expect(bounced.stopReason).toBe('HARD_BOUNCE');

    const suppressed = planT1FollowUpSequence({ ...baseInput, suppressed: true });
    expect(suppressed.stopped).toBe(true);
    expect(suppressed.stopReason).toBe('SUPPRESSED');
  });

  it('hard-blocks strict D3 opt-in countries (DE) without OPT_IN and fails closed on DNC error', () => {
    const deBlocked = planT1FollowUpSequence({
      ...baseInput,
      countryCode: 'DE',
      consentStatus: 'MISSING',
    });
    expect(deBlocked.stopped).toBe(true);
    expect(deBlocked.stopReason).toBe('JURISDICTION_BLOCKED');
    expect(deBlocked.steps.every((s) => s.status === 'blocked')).toBe(true);

    const deOptIn = planT1FollowUpSequence({
      ...baseInput,
      countryCode: 'DE',
      consentStatus: 'OPT_IN',
      rounds: 2,
    });
    expect(deOptIn.stopped).toBe(false);
    expect(deOptIn.steps).toHaveLength(2);
    expect(deOptIn.steps.map((s) => s.dayOffset)).toEqual([0, 3]);

    const dncFail = planT1FollowUpSequence({ ...baseInput, dncCheckFailed: true });
    expect(dncFail.stopped).toBe(true);
    expect(dncFail.stopReason).toBe('DNC_UNAVAILABLE');
  });
});

describe('validateT1Attachments', () => {
  it('accepts up to 3 ready PDF/HTML seller documents within 10MB', () => {
    const res = validateT1Attachments([
      {
        documentId: '11111111-1111-4111-8111-111111111111',
        filename: 'HJT-700W-Datasheet.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2_400_000,
        status: 'ready',
      },
      {
        documentId: '22222222-2222-4222-8222-222222222222',
        filename: 'Catalog.html',
        mimeType: 'text/html',
        sizeBytes: 120_000,
        status: 'ready',
      },
    ]);
    expect(res.ok).toBe(true);
    expect(res.valid).toHaveLength(2);
    expect(res.errors).toEqual([]);
  });

  it('rejects non-ready status, disallowed MIME, oversized files, and >3 attachments', () => {
    const res = validateT1Attachments([
      {
        documentId: '11111111-1111-4111-8111-111111111111',
        filename: 'processing.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1000,
        status: 'processing',
      },
      {
        documentId: '22222222-2222-4222-8222-222222222222',
        filename: 'payload.exe',
        mimeType: 'application/x-msdownload',
        sizeBytes: 1000,
        status: 'ready',
      },
      {
        documentId: '33333333-3333-4333-8333-333333333333',
        filename: 'huge.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 15 * 1024 * 1024,
        status: 'ready',
      },
      {
        documentId: '44444444-4444-4444-8444-444444444444',
        filename: 'fourth.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1000,
        status: 'ready',
      },
    ]);
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toContain('ATTACHMENT_NOT_READY');
    expect(res.errors.map((e) => e.code)).toContain('ATTACHMENT_MIME_NOT_ALLOWED');
    expect(res.errors.map((e) => e.code)).toContain('ATTACHMENT_TOO_LARGE');
    expect(res.errors.map((e) => e.code)).toContain('ATTACHMENT_LIMIT_EXCEEDED');
  });
});

describe('extractReferredContacts', () => {
  it('extracts referred emails from both structured arrays and [referred: ...] snippet tags without duplicating sender', () => {
    const leads = extractReferredContacts([
      {
        id: 'r-1',
        contactRef: '11111111-1111-4111-8111-111111111111',
        recipientEmail: 'info@buyer-it.example',
        kind: 'REPLY',
        classification: 'POSITIVE',
        subject: 'Re: Solar supply',
        snippet: 'Please contact our procurement head [referred: procurement@buyer-it.example, INFO@buyer-it.example]',
        receivedAt: '2026-11-26T09:00:00.000Z',
      },
      {
        id: 'r-2',
        contactRef: '22222222-2222-4222-8222-222222222222',
        recipientEmail: 'sales@buyer-fr.example',
        kind: 'REPLY',
        classification: 'NEUTRAL',
        referredEmails: ['buyer.lead@buyer-fr.example', 'procurement@buyer-it.example'],
        receivedAt: '2026-11-26T10:00:00.000Z',
      },
    ]);
    expect(leads.map((l) => l.referredEmail)).toEqual([
      'procurement@buyer-it.example',
      'buyer.lead@buyer-fr.example',
    ]);
    expect(leads[0]?.replyId).toBe('r-1');
  });
});

describe('icebreakers, structured rejection mapping, and DNS advice', () => {
  it('normalizes signal icebreakers, strips unsafe URLs, and prepends idempotently', () => {
    const list = normalizeIcebreakerSuggestions({
      icebreakerSuggestions: [
        {
          signalType: 'TENDER_AWARDED',
          signalTitle: 'Won 18MW Tuscany PV EPC',
          signalUrl: 'https://ted.europa.eu/notice/12345',
          detectedAt: '2026-11-20T00:00:00.000Z',
          openerZh: '祝贺贵司中标托斯卡纳 18MW 光伏 EPC 项目。',
          openerEn: 'Congratulations on winning the 18MW Tuscany PV EPC award.',
        },
        {
          signalType: 'PAGE_CHANGE',
          signalTitle: 'XSS attempt',
          signalUrl: 'javascript:alert(1)',
          detectedAt: null,
          openerZh: '注意到贵司近期更新了产品目录。',
          openerEn: 'Noticed your recent catalog update.',
        },
      ],
    });
    expect(list).toHaveLength(2);
    expect(list[0]?.signalUrl).toBe('https://ted.europa.eu/notice/12345');
    expect(list[1]?.signalUrl).toBeNull();

    const once = insertIcebreakerIntoBody(list[0]!.openerEn, 'Hello team,\n\nWe supply HJT modules.');
    expect(once.startsWith(list[0]!.openerEn)).toBe(true);
    const twice = insertIcebreakerIntoBody(list[0]!.openerEn, once);
    expect(twice).toBe(once);
  });

  it('maps UI reject codes to Track 3B structured feedback reasons and normalizes feedback summary', () => {
    expect(mapRejectCodeToFeedbackReason('NOT_TARGET_ROLE')).toBe('wrong_role_peer');
    expect(mapRejectCodeToFeedbackReason('WRONG_PRODUCT')).toBe('wrong_industry');
    expect(mapRejectCodeToFeedbackReason('TOO_SMALL')).toBe('too_small');
    expect(mapRejectCodeToFeedbackReason('WRONG_COUNTRY')).toBe('wrong_country');
    expect(mapRejectCodeToFeedbackReason('DEAD_COMPANY')).toBe('dead_company');
    expect(mapRejectCodeToFeedbackReason('BAD_CONTACT_PATH')).toBe('bounced_unreachable');

    const summary = normalizeIcpFeedbackSummary({
      icpId: 'icp-1',
      icpName: '意大利光伏分销商',
      icpVersion: 3,
      excludedDomains: ['peer-factory.com'],
      excludedKeywords: ['光伏组件工厂'],
      excludedBusinessModels: ['upstream_manufacturer'],
      counterExamples: [
        {
          domain: 'peer-factory.com',
          companyName: 'Peer Solar Co.',
          industry: 'Solar Manufacturing',
          outcome: 'rejected',
          reason: 'wrong_role_peer',
          note: '上游组件制造同行',
          recordedAt: '2026-11-26T00:00:00.000Z',
        },
      ],
      positiveExamples: [
        {
          domain: 'memodo.it',
          companyName: 'Memodo Italia',
          industry: 'Solar Distribution',
          outcome: 'replied_positive',
          recordedAt: '2026-11-26T01:00:00.000Z',
        },
      ],
      stats: {
        totalRecorded: 6,
        outcomeCounts: { rejected: 5, replied_positive: 1 },
        rejectionReasonCounts: { wrong_role_peer: 4, too_small: 1 },
        lastRecordedAt: '2026-11-26T01:00:00.000Z',
      },
    });
    expect(summary.excludedDomains).toEqual(['peer-factory.com']);
    expect(summary.excludedBusinessModels).toEqual(['upstream_manufacturer']);
    expect(summary.counterExamples).toHaveLength(1);
    expect(summary.counterExamples[0]?.reason).toBe('wrong_role_peer');
    expect(summary.positiveExamples).toHaveLength(1);
    expect(summary.stats.totalRecorded).toBe(6);
    expect(summary.stats.rejectionReasonCounts.wrong_role_peer).toBe(4);
  });

  it('builds actionable DNS health advice for missing SPF/DKIM/DMARC/MX', () => {
    const partial = evaluateDomainDnsAdvice({
      domain: 'send.example.com',
      ok: { spf: true, dkim: false, dmarc: true, mx: true },
      spf: { present: true, record: 'v=spf1 ~all', qualifier: '~all' },
      dmarc: { present: true, record: 'v=DMARC1; p=none', policy: 'none', pct: 100, hasRua: false },
      dkim: { present: false, selector: 'google' },
      mx: [{ exchange: 'smtp.google.com', priority: 1 }],
      ready: false,
    });
    expect(partial.score).toBe(3);
    expect(partial.ready).toBe(false);
    expect(partial.items.find((i) => i.key === 'dkim')?.severity).toBe('error');
    expect(partial.items.find((i) => i.key === 'dmarc')?.severity).toBe('warn');
  });
});

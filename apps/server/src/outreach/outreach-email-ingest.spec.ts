import { describe, expect, it } from 'vitest';
import {
  looksLikeUnsubscribe,
  parseArf,
  parseDsn,
  parseEmail,
} from './outreach-email-ingest.js';

const REPLY_RAW = [
  'From: Buyer <buyer@ziel.de>',
  'To: outreach@example.test',
  'Subject: Re: Pumpen – kurze Frage',
  'Message-ID: <reply-1@ziel.de>',
  'In-Reply-To: <sent-1@example.test>',
  'References: <sent-0@example.test> <sent-1@example.test>',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Danke, aber kein Interesse. Bitte abmelden.',
  '',
].join('\r\n');

function dsnRaw(status: string, displayName = 'buyer@example.de'): string {
  return [
    'From: Mail Delivery System <MAILER-DAEMON@mx.example.test>',
    'To: outreach@example.test',
    'Subject: Undelivered Mail Returned to Sender',
    'Message-ID: <dsn-1@mx.example.test>',
    'Content-Type: multipart/report; report-type=delivery-status;',
    ' boundary="boundary-42"',
    '',
    '--boundary-42',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'This is the mail system. Delivery failed.',
    '',
    '--boundary-42',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.example.test',
    'Arrival-Date: Wed, 11 Nov 2026 09:00:00 +0000',
    '',
    'Final-Recipient: rfc822; ' + displayName,
    'Action: failed',
    `Status: ${status}`,
    'Diagnostic-Code: smtp; 550 5.1.1 user unknown',
    '',
    '--boundary-42',
    'Content-Type: message/rfc822',
    '',
    'From: outreach@example.test',
    'To: ' + displayName,
    'Message-ID: <sent-1@example.test>',
    'Subject: Pumpen – kurze Frage',
    '',
    'original body',
    '--boundary-42--',
    '',
  ].join('\r\n');
}

const ARF_RAW = [
  'From: complaints@isp.example',
  'To: abuse@example.test',
  'Subject: Complaint about message',
  'Message-ID: <arf-1@isp.example>',
  'Content-Type: multipart/report; report-type=feedback-report; boundary="arf-bound"',
  '',
  '--arf-bound',
  'Content-Type: text/plain',
  '',
  'This is an abuse report.',
  '',
  '--arf-bound',
  'Content-Type: message/feedback-report',
  '',
  'Feedback-Type: abuse',
  'User-Agent: SomeGenerator/1.0',
  'Original-Rcpt-To: buyer@ziel.de',
  'Original-Message-ID: <sent-2@example.test>',
  '',
  '--arf-bound',
  'Content-Type: message/rfc822',
  '',
  'Message-ID: <sent-2@example.test>',
  '',
  'original body',
  '--arf-bound--',
  '',
].join('\r\n');

describe('parseEmail（MIME 基础解析）', () => {
  it('解析头（含折行）、quoted-printable 正文与 References', () => {
    const email = parseEmail(REPLY_RAW);
    expect(email.subject).toBe('Re: Pumpen – kurze Frage');
    expect(email.messageId).toBe('reply-1@ziel.de');
    expect(email.inReplyTo).toBe('sent-1@example.test');
    expect(email.references).toEqual(['sent-0@example.test', 'sent-1@example.test']);
    expect(email.textBody).toContain('kein Interesse');
  });

  it('base64 正文解码', () => {
    const raw = [
      'From: a@b.de',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('Bitte entfernen: unsubscribe', 'utf8').toString('base64'),
    ].join('\r\n');
    expect(parseEmail(raw).textBody).toContain('unsubscribe');
  });

  it('multipart 拆分为多个 part（含 report-type）', () => {
    const email = parseEmail(dsnRaw('5.1.1'));
    expect(email.contentType).toBe('multipart/report');
    expect(email.reportType).toBe('delivery-status');
    expect(email.parts.map((part) => part.contentType)).toEqual([
      'text/plain',
      'message/delivery-status',
      'message/rfc822',
    ]);
  });
});

describe('parseDsn（退信解析：硬退/软退）', () => {
  it('5.x.x 判为硬退，解析收件人与原邮件 id（来自 message/rfc822）', () => {
    const bounce = parseDsn(parseEmail(dsnRaw('5.1.1')))!;
    expect(bounce).toMatchObject({
      hard: true,
      status: '5.1.1',
      action: 'failed',
      recipient: 'buyer@example.de',
      messageId: 'sent-1@example.test',
    });
    expect(bounce.diagnostic).toContain('550');
  });

  it('4.x.x 判为软退', () => {
    const bounce = parseDsn(parseEmail(dsnRaw('4.2.2')))!;
    expect(bounce.hard).toBe(false);
    expect(bounce.status).toBe('4.2.2');
  });

  it('普通回复不是退信', () => {
    expect(parseDsn(parseEmail(REPLY_RAW))).toBeNull();
  });
});

describe('parseArf（投诉报告）', () => {
  it('feedback-report 解析 Feedback-Type/原收件人/原邮件 id', () => {
    const complaint = parseArf(parseEmail(ARF_RAW))!;
    expect(complaint).toMatchObject({
      feedbackType: 'abuse',
      recipient: 'buyer@ziel.de',
      messageId: 'sent-2@example.test',
    });
  });

  it('普通回复不是投诉', () => {
    expect(parseArf(parseEmail(REPLY_RAW))).toBeNull();
  });
});

describe('looksLikeUnsubscribe（保守关键词识别）', () => {
  it('德文 abmelden 与法文 désinscrire 命中；普通回复不命中', () => {
    expect(looksLikeUnsubscribe(parseEmail(REPLY_RAW))).toBe(true);
    const fr = parseEmail(
      ['From: a@b.fr', 'Subject: Merci', '', 'Merci de me désinscrire de votre liste.'].join(
        '\r\n',
      ),
    );
    expect(looksLikeUnsubscribe(fr)).toBe(true);
    const normal = parseEmail(
      ['From: a@b.de', 'Subject: Termin', '', 'Passt Ihnen Dienstag um 10 Uhr?'].join('\r\n'),
    );
    expect(looksLikeUnsubscribe(normal)).toBe(false);
  });
});

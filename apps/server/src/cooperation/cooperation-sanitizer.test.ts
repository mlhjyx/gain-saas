import { describe, expect, it } from 'vitest';
import { cleanEmail, cleanText, ContentRejectedError } from './cooperation-sanitizer.js';

describe('cleanText', () => {
  it('trims, collapses single-line whitespace and normalizes width', () => {
    expect(cleanText('name', '  张　三 \n ', { max: 20, required: true })).toBe('张 三');
  });

  it('rejects missing required fields', () => {
    expect(() => cleanText('name', '   ', { max: 20, required: true })).toThrow(ContentRejectedError);
    expect(() => cleanText('name', '', { max: 20, required: true })).toThrow(/REQUIRED/);
  });

  it('returns null for optional empty fields', () => {
    expect(cleanText('company', '  ', { max: 20 })).toBeNull();
    expect(cleanText('company', undefined, { max: 20 })).toBeNull();
  });

  it('preserves Chinese full-width punctuation (NFC storage)', () => {
    expect(cleanText('message', '我们在德国有渠道，希望合作。', { max: 100, multiline: true })).toBe(
      '我们在德国有渠道，希望合作。',
    );
  });

  it('rejects full-width obfuscated tags after NFKC comparison', () => {
    expect(() => cleanText('name', '＜script＞alert(1)＜/script＞', { max: 100, required: true })).toThrow(/UNSAFE/);
  });

  it('rejects HTML tags and script protocols', () => {
    for (const payload of [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      'javascript:alert(1)',
      'JavaScript : alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'onerror = alert(1)',
      '&lt;script&gt;alert(1)&lt;/script&gt;',
      '&#60;script&#62;',
    ]) {
      expect(() => cleanText('name', payload, { max: 500, required: true }), payload).toThrow(/UNSAFE/);
    }
  });

  it('rejects named-entity and semicolon-less numeric obfuscation', () => {
    for (const payload of [
      'javascript&colon;alert(1)',
      'java&Tab;script:alert(1)',
      'java&NewLine;script:alert(1)',
      '&#60script&#62alert(1)',
      '&#x3cscript&#x3ealert(1)',
    ]) {
      expect(() => cleanText('message', payload, { max: 200, multiline: true }), payload).toThrow(/UNSAFE/);
    }
  });

  it('rejects scheme names split by newlines/whitespace', () => {
    expect(() => cleanText('message', 'java\nscript:alert(1)', { max: 200, multiline: true })).toThrow(/UNSAFE/);
    expect(() => cleanText('message', 'data : text/html;base64,x', { max: 200, multiline: true })).toThrow(/UNSAFE/);
  });

  it('does not reject ordinary URL query strings or prose', () => {
    expect(cleanText('contact', 'https://example.com/?online=true', { max: 300 })).toBe('https://example.com/?online=true');
    expect(cleanText('message', '我们希望强化品牌的 expression (visual identity) 表达', { max: 200, multiline: true })).toBe(
      '我们希望强化品牌的 expression (visual identity) 表达',
    );
  });

  it('strips zero-width and control characters before checking', () => {
    expect(cleanText('name', '张​三\u0000', { max: 20, required: true })).toBe('张三');
    expect(() => cleanText('name', '<scr​ipt>', { max: 50, required: true })).toThrow(/UNSAFE/);
  });

  it('allows benign angle-bracket text that is not a tag', () => {
    expect(cleanText('message', '年营收 < 500 万', { max: 50 })).toBe('年营收 < 500 万');
  });

  it('enforces max length by code points', () => {
    expect(() => cleanText('message', '😀'.repeat(11), { max: 10 })).toThrow(/TOO_LONG/);
    expect(cleanText('message', '😀'.repeat(10), { max: 10 })).toBe('😀'.repeat(10));
  });

  it('keeps newlines only for multiline fields', () => {
    expect(cleanText('message', '第一行\n第二行', { max: 100, multiline: true })).toBe('第一行\n第二行');
    expect(cleanText('name', '第一行\n第二行', { max: 100 })).toBe('第一行 第二行');
  });

  it('rejects non-string values', () => {
    expect(() => cleanText('name', 123, { max: 20, required: true })).toThrow(/INVALID_TYPE/);
  });
});

describe('cleanEmail', () => {
  it('lowercases and trims a valid address', () => {
    expect(cleanEmail('  Foo.Bar@Example.COM ')).toBe('foo.bar@example.com');
  });

  it('rejects malformed addresses', () => {
    expect(() => cleanEmail('not-an-email')).toThrow(/INVALID_TYPE/);
    expect(() => cleanEmail('a@b')).toThrow(/INVALID_TYPE/);
    expect(() => cleanEmail('')).toThrow(/REQUIRED/);
  });

  it('rejects payloads hiding in the local part', () => {
    expect(() => cleanEmail('<script>@example.com')).toThrow(/UNSAFE/);
  });

  it('rejects mailto-parameter injection and overlong lowercase expansions', () => {
    expect(() => cleanEmail('a@b.co?subject=hi')).toThrow(/INVALID_TYPE/);
    expect(() => cleanEmail('a@b.co%0d%0aX: y')).toThrow(/INVALID_TYPE/);
    // U+0130 小写化后变成 i + U+0307，254 码点会膨胀到 508，必须在落库前拒绝。
    expect(() => cleanEmail('İ'.repeat(250) + '@a.b')).toThrow(/TOO_LONG/);
  });
});

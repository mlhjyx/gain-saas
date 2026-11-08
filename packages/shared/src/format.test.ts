import { describe, expect, it } from 'vitest';

import { formatDate, formatDateTime, formatDateTimeSeconds } from './format.js';

const at = new Date(2026, 10, 9, 7, 5, 42); // 本地时区 2026-11-09 07:05:42

describe('formatDate / formatDateTime', () => {
  it('固定 YYYY-MM-DD / YYYY-MM-DD HH:mm 形状', () => {
    expect(formatDate(at)).toBe('2026-11-09');
    expect(formatDateTime(at)).toBe('2026-11-09 07:05');
    expect(formatDateTimeSeconds(at)).toBe('2026-11-09 07:05:42');
  });

  it('接受 ISO 字符串、毫秒时间戳与 Date', () => {
    expect(formatDateTime(at.toISOString())).toBe('2026-11-09 07:05');
    expect(formatDateTime(at.getTime())).toBe('2026-11-09 07:05');
  });

  it('补零：个位数月份/日/时/分/秒', () => {
    expect(formatDateTime(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02 03:04');
    expect(formatDateTimeSeconds(new Date(2026, 0, 2, 3, 4, 5))).toBe(
      '2026-01-02 03:04:05',
    );
  });

  it('无效输入返回空串，不抛错', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
    expect(formatDate('')).toBe('');
    expect(formatDateTime('not-a-date')).toBe('');
  });

  it('不随系统 locale 变化（与 toLocaleString 的本质区别）', () => {
    const formatted = formatDateTime(at);
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

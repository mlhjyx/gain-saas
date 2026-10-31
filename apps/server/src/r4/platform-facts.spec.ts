import { describe, expect, it } from 'vitest';
import { bindingInstant } from './platform-facts.service.js';

describe('部署绑定时间戳', () => {
  it('epoch 毫秒与 ISO 字符串都能折算', () => {
    expect(bindingInstant(1793991688362)).toBe(1793991688362);
    expect(bindingInstant('2026-11-06T00:00:00.000Z')).toBe(Date.parse('2026-11-06T00:00:00.000Z'));
  });

  it('其他类型一律 NaN（调用方据此判不可用）', () => {
    expect(Number.isNaN(bindingInstant(undefined))).toBe(true);
    expect(Number.isNaN(bindingInstant(null))).toBe(true);
    expect(Number.isNaN(bindingInstant('not-a-date'))).toBe(true);
    expect(Number.isNaN(bindingInstant({}))).toBe(true);
  });
});

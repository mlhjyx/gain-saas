import { describe, expect, it } from 'vitest';
import { canonicalizeJson, planHashOf } from './campaign-plan.canonical.js';

describe('canonical JSON 与 plan_hash', () => {
  it('键序无关：同一计划不同书写顺序得到同一指纹', () => {
    const a = planHashOf({ b: 1, a: 'x', nested: { d: [1, 2], c: true } });
    const b = planHashOf({ nested: { c: true, d: [1, 2] }, a: 'x', b: 1 });
    expect(a).toBe(b);
  });

  it('数组顺序敏感：不同顺序不同指纹', () => {
    expect(planHashOf({ a: [1, 2] })).not.toBe(planHashOf({ a: [2, 1] }));
  });

  it('字符串按 JSON 转义规范化', () => {
    expect(canonicalizeJson('a"b')).toBe(JSON.stringify('a"b'));
  });

  it('拒绝浮点与非有限数', () => {
    expect(() => canonicalizeJson(1.5)).toThrow();
    expect(() => canonicalizeJson(Number.NaN)).toThrow();
    expect(() => canonicalizeJson({ a: Number.POSITIVE_INFINITY })).toThrow();
  });

  it('undefined 字段被跳过（等价于未提供）', () => {
    expect(planHashOf({ a: 1, b: undefined })).toBe(planHashOf({ a: 1 }));
  });
});

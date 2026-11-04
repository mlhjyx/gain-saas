import { describe, expect, it } from 'vitest';
import { OpsExportThrottle } from './ops-export-throttle.js';

describe('OpsExportThrottle', () => {
  it('窗口内允许到上限，超出拒绝', () => {
    const throttle = new OpsExportThrottle(2, 60_000);
    const t = 1_000_000;
    expect(throttle.allow('op-1', t)).toBe(true);
    expect(throttle.allow('op-1', t + 1_000)).toBe(true);
    expect(throttle.allow('op-1', t + 2_000)).toBe(false);
  });

  it('窗口滑过后恢复', () => {
    const throttle = new OpsExportThrottle(1, 60_000);
    const t = 1_000_000;
    expect(throttle.allow('op-1', t)).toBe(true);
    expect(throttle.allow('op-1', t + 30_000)).toBe(false);
    expect(throttle.allow('op-1', t + 61_000)).toBe(true);
  });

  it('不同操作员互不影响', () => {
    const throttle = new OpsExportThrottle(1, 60_000);
    expect(throttle.allow('op-1', 1_000)).toBe(true);
    expect(throttle.allow('op-2', 1_000)).toBe(true);
  });
});

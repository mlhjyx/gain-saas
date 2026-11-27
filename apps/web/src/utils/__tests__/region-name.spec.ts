import { preferences, updatePreferences } from '@vben/preferences';
import { describe, expect, it } from 'vitest';

import { regionName } from '../region-name';

describe('regionName', () => {
  it('将两位码与英文/中文国家全称归一化为同一界面语言，消除 Germany 与 德国 重复', () => {
    const prev = preferences.app.locale;
    try {
      updatePreferences({ app: { locale: 'zh-CN' } });
      expect(regionName('DE')).toBe('德国');
      expect(regionName('Germany')).toBe('德国');
      expect(regionName('Deutschland')).toBe('德国');
      expect(regionName('GB')).toBe('英国');
      expect(regionName('UK')).toBe('英国');
      expect(regionName('United Kingdom')).toBe('英国');
      expect(regionName('Czech Republic')).toBe('捷克');
      expect(regionName('Turkey')).toBe('土耳其');
      expect(regionName('Türkiye')).toBe('土耳其');

      // 去重后不再中英文混排或重复国家
      const deduped = [...new Set(['Germany', 'United Kingdom', 'DE'].map(regionName))];
      expect(deduped).toEqual(['德国', '英国']);

      updatePreferences({ app: { locale: 'en-US' } });
      expect(regionName('DE')).toBe('Germany');
      expect(regionName('德国')).toBe('Germany');
      expect(regionName('GB')).toBe('United Kingdom');
      expect(regionName('UnknownRegionXyz')).toBe('UnknownRegionXyz');
    } finally {
      updatePreferences({ app: { locale: prev } });
    }
  });
});

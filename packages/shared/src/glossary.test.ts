import { describe, expect, it } from 'vitest';

import {
  APPROVAL_STATE,
  GLOSSARY,
  glossaryStatus,
  glossaryTerm,
  ICP_STATUS,
  LEAD_QUEUE,
  NAV,
  navLabel,
  OUTCOME_STATE,
  statusClass,
  STATUS_TABLES,
} from './glossary.js';

const BANNED = [
  /\brun\b/i,
  /\bICP\b/i,
  /\bcanonical\b/i,
  /plan[_-]?hash/i,
  /\b(PARTIAL|FAILED|RISKY)\b/,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
];

function bannedHit(text: string): string | null {
  for (const re of BANNED) {
    if (re.test(text)) return re.source;
  }
  return null;
}

describe('glossary 词表（M2 步 14 §4）', () => {
  it('对象与状态词条都有中文与英文，且界面用语不含禁用词', () => {
    const offenders: string[] = [];
    for (const [key, term] of Object.entries(GLOSSARY)) {
      if (!term.zh || !term.en) offenders.push(`${key}: 缺 zh/en`);
      for (const label of [term.zh, term.en]) {
        const hit = bannedHit(label);
        if (hit) offenders.push(`${key}: ${label} 命中 ${hit}`);
      }
    }
    for (const [key, term] of Object.entries(NAV)) {
      if (!term.zh || !term.en) offenders.push(`nav.${key}: 缺 zh/en`);
      for (const label of [term.zh, term.en]) {
        const hit = bannedHit(label);
        if (hit) offenders.push(`nav.${key}: ${label} 命中 ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('状态词条都有文案与合法色板', () => {
    const tones = new Set(['neutral', 'processing', 'success', 'warning', 'danger']);
    const offenders: string[] = [];
    for (const [domain, table] of Object.entries(STATUS_TABLES)) {
      for (const [value, status] of Object.entries(table as Record<string, { zh: string; en: string; tone: string }>)) {
        if (!status.zh || !status.en) offenders.push(`${domain}.${value}: 缺 zh/en`);
        if (!tones.has(status.tone)) offenders.push(`${domain}.${value}: 非法 tone ${status.tone}`);
        const hit = bannedHit(status.zh) ?? bannedHit(status.en);
        if (hit) offenders.push(`${domain}.${value}: 命中 ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('一级导航是设计钉死的六项且顺序固定', () => {
    expect(Object.keys(NAV)).toEqual([
      'workspace',
      'companies',
      'findBuyers',
      'leads',
      'growth',
      'settings',
    ]);
    expect(navLabel('growth')).toBe('商机与触达');
    expect(navLabel('growth', 'en-US')).toBe('Opportunities & outreach');
  });

  it('取词按语言切换，未登记状态返回 null（不得把裸枚举写上界面）', () => {
    expect(glossaryTerm('run')).toBe('挖掘任务');
    expect(glossaryTerm('run', 'en-US')).toBe('Discovery task');
    expect(glossaryTerm('icp')).toBe('目标客户画像');
    expect(glossaryStatus('run', 'PARTIAL')).toEqual({ label: '部分完成', tone: 'warning' });
    expect(glossaryStatus('run', 'PARTIAL', 'en-US')).toEqual({
      label: 'Partially completed',
      tone: 'warning',
    });
    expect(glossaryStatus('run', 'SOMETHING_NEW')).toBeNull();
    expect(glossaryStatus('run', null)).toBeNull();
    expect(statusClass('warning')).toBe('gs-badge--warning');
  });

  it('关键对象按 M2 词表映射（任务卡钉死的四组）', () => {
    expect(glossaryTerm('run')).toBe('挖掘任务');
    expect(glossaryTerm('icp')).toBe('目标客户画像');
    expect(glossaryTerm('campaign')).toBe('战役计划');
    expect(glossaryTerm('qgo')).toBe('商机');
  });

  it('状态表覆盖本轮上线的对象（防线：新增域必须补表）', () => {
    expect(Object.keys(ICP_STATUS)).toContain('ACTIVE');
    expect(Object.keys(LEAD_QUEUE)).toEqual([
      'needs_review',
      'recommended',
      'rejected',
      'suppressed',
      'sanctions_hold',
    ]);
    expect(Object.keys(APPROVAL_STATE)).toEqual(['PENDING', 'APPROVED', 'DECLINED', 'EXPIRED']);
    expect(Object.keys(OUTCOME_STATE)).toContain('WON');
  });
});

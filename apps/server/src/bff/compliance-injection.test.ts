import { describe, expect, it } from 'vitest';
import { BFF_ROUTES, injectDeclaredCompliance } from './routes.js';

const DECLARED = {
  basis: 'legitimate_interest',
  ref: 'LIA-2026-11',
  note: '利益均衡评估摘要',
  version: 2,
  declaredAt: new Date('2026-11-03T10:00:00Z'),
};

describe('D6 合法依据自动注入', () => {
  it('injects the declared basis with a version snapshot when the request carries none', () => {
    expect(injectDeclaredCompliance({ attemptId: 'a1' }, DECLARED)).toEqual({
      attemptId: 'a1',
      lawfulBasis: 'legitimate_interest',
      lawfulBasisRef: 'LIA-2026-11',
      // 引擎 note 上限 1000 且禁换行：注入版本戳，声明全文只存 SaaS。
      lawfulBasisNote: 'declared v2 2026-11-03',
    });
  });

  it('keeps an explicit request basis untouched', () => {
    const body = { lawfulBasis: 'consent', lawfulBasisRef: 'own', lawfulBasisNote: 'mine' };
    expect(injectDeclaredCompliance(body, DECLARED)).toBe(body);
  });

  it('passes the body through when the tenant has not declared anything', () => {
    const body = { attemptId: 'a1' };
    expect(injectDeclaredCompliance(body, null)).toBe(body);
  });

  it('stamps the version even when the declaration has no note', () => {
    expect(injectDeclaredCompliance({}, { ...DECLARED, note: null, ref: null })).toEqual({
      lawfulBasis: 'legitimate_interest',
      lawfulBasisNote: 'declared v2 2026-11-03',
    });
  });

  it('compresses multi-line / over-long refs into one bounded line the engine accepts', () => {
    const out = injectDeclaredCompliance(
      {},
      { ...DECLARED, ref: `LIA-1\n第二行\u0000 ${'长'.repeat(600)}` },
    ) as Record<string, unknown>;
    expect(out.lawfulBasisRef).not.toMatch(/[\u0000-\u001f\u007f]/u);
    expect((out.lawfulBasisRef as string).length).toBeLessThanOrEqual(512);
    expect(out.lawfulBasisRef).toMatch(/^LIA-1 第二行 长+$/u);
  });

  it('never injects the long declaration note (engine caps it at 1000 chars, single line)', () => {
    const longNote = '甲'.repeat(4000);
    const out = injectDeclaredCompliance({}, { ...DECLARED, note: longNote }) as Record<string, unknown>;
    expect((out.lawfulBasisNote as string).length).toBeLessThanOrEqual(1000);
    expect(out.lawfulBasisNote).toBe('declared v2 2026-11-03');
  });

  it('flags exactly the three contact-compliance routes for injection', () => {
    const flagged = BFF_ROUTES.filter((r) => r.complianceInject).map((r) => r.enginePath).sort();
    expect(flagged).toEqual([
      '/canonical-companies/:id/discover-contacts',
      '/canonical-companies/:id/guess-emails',
      '/contact-points/:pointId/verify',
    ]);
  });
});

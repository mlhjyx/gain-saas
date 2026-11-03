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
      lawfulBasisNote: '利益均衡评估摘要 | declared v2 2026-11-03',
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

  it('flags exactly the three contact-compliance routes for injection', () => {
    const flagged = BFF_ROUTES.filter((r) => r.complianceInject).map((r) => r.enginePath).sort();
    expect(flagged).toEqual([
      '/canonical-companies/:id/discover-contacts',
      '/canonical-companies/:id/guess-emails',
      '/contact-points/:pointId/verify',
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { BFF_ROUTES, PLATFORM_LAWFUL_BASIS, injectPlatformLawfulBasis } from './routes.js';

describe('平台级合法依据自动注入（2026-11-04 取消租户声明）', () => {
  it('injects the platform LIA reference when the request carries no basis', () => {
    expect(injectPlatformLawfulBasis({ attemptId: 'a1' })).toEqual({
      attemptId: 'a1',
      lawfulBasis: 'legitimate_interest',
      lawfulBasisRef: PLATFORM_LAWFUL_BASIS.ref,
      lawfulBasisNote: PLATFORM_LAWFUL_BASIS.note,
    });
  });

  it('injects into an empty body as well (discover-contacts may be body-less)', () => {
    expect(injectPlatformLawfulBasis(undefined)).toEqual({
      lawfulBasis: 'legitimate_interest',
      lawfulBasisRef: PLATFORM_LAWFUL_BASIS.ref,
      lawfulBasisNote: PLATFORM_LAWFUL_BASIS.note,
    });
  });

  it('keeps an explicit request basis untouched (per-call override stays possible)', () => {
    const body = { lawfulBasis: 'consent', lawfulBasisRef: 'own', lawfulBasisNote: 'mine' };
    expect(injectPlatformLawfulBasis(body)).toBe(body);
  });

  it('platform ref and note obey the engine caps: single line, ref ≤512, note ≤1000', () => {
    const out = injectPlatformLawfulBasis({}) as Record<string, unknown>;
    expect(out.lawfulBasisRef as string).toMatch(/^[^\u0000-\u001f\u007f]+$/u);
    expect((out.lawfulBasisRef as string).length).toBeLessThanOrEqual(512);
    expect(out.lawfulBasisNote as string).toMatch(/^[^\u0000-\u001f\u007f]+$/u);
    expect((out.lawfulBasisNote as string).length).toBeLessThanOrEqual(1000);
  });

  it('names the platform owner decision as the lawful-basis reference', () => {
    expect(PLATFORM_LAWFUL_BASIS).toMatchObject({
      basis: 'legitimate_interest',
      ref: 'OWNER-DECISION-2026-10-11',
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

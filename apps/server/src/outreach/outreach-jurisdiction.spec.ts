import { describe, expect, it } from 'vitest';
import {
  evaluateEmailJurisdiction,
  outreachJurisdictionPolicy,
} from './outreach-jurisdiction.js';

const US_ADDRESS = 'GainOS Inc., 2261 Market Street #4000, San Francisco, CA 94114';
const FR_NOTICE =
  'Vos coordonnées professionnelles proviennent de sources publiques (site de votre entreprise). Vous pouvez vous opposer à tout moment via le lien de désinscription.';

function evaluate(
  countryCode: unknown,
  consentStatus: 'OPT_IN' | 'OPT_OUT' | 'UNKNOWN' | 'MISSING',
  config: { usPostalAddress?: string; frSourceNotice?: string } = {},
) {
  return evaluateEmailJurisdiction({ countryCode, consentStatus, ...config });
}

describe('outreachJurisdictionPolicy（v0 常量矩阵的向后兼容导出）', () => {
  it('DE/AT 要求同意，US/FR 走反对制，其它法域默认人工复核', () => {
    expect(outreachJurisdictionPolicy('DE')).toBe('CONSENT_REQUIRED');
    expect(outreachJurisdictionPolicy('at')).toBe('CONSENT_REQUIRED');
    expect(outreachJurisdictionPolicy('US')).toBe('OPT_OUT');
    expect(outreachJurisdictionPolicy('FR')).toBe('OPT_OUT');
    expect(outreachJurisdictionPolicy('IT')).toBe('REVIEW_REQUIRED');
    expect(outreachJurisdictionPolicy(undefined)).toBe('REVIEW_REQUIRED');
  });
});

describe('evaluateEmailJurisdiction（发送路径上的法域同意门）', () => {
  it('DE 有 OPT_IN 同意时放行，无需额外页脚', () => {
    const decision = evaluate('DE', 'OPT_IN');
    expect(decision.allowed).toBe(true);
    expect(decision.policy).toBe('CONSENT_REQUIRED');
    expect(decision.footerLines).toEqual([]);
  });

  it('负向：DE 无同意记录（MISSING）一律拒绝 — JURISDICTION_CONSENT_REQUIRED', () => {
    const decision = evaluate('DE', 'MISSING');
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('JURISDICTION_CONSENT_REQUIRED');
  });

  it('负向：DE 仅有 UNKNOWN 同意状态也拒绝（UWG §7(2) Nr.2 需要明确同意）', () => {
    const decision = evaluate('DE', 'UNKNOWN');
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('JURISDICTION_CONSENT_REQUIRED');
  });

  it('负向：AT 与 DE 同策略 — 无 OPT_IN 即拒绝', () => {
    expect(evaluate('AT', 'MISSING').code).toBe('JURISDICTION_CONSENT_REQUIRED');
    expect(evaluate('AT', 'OPT_IN').allowed).toBe(true);
  });

  it('US 无同意记录可发（CAN-SPAM opt-out），但必须带物理地址页脚', () => {
    const decision = evaluate('US', 'UNKNOWN', { usPostalAddress: US_ADDRESS });
    expect(decision.allowed).toBe(true);
    expect(decision.policy).toBe('OPT_OUT');
    expect(decision.footerLines).toContain(US_ADDRESS);
  });

  it('负向：US 未配置物理地址时拒绝 — JURISDICTION_US_POSTAL_ADDRESS_REQUIRED', () => {
    const decision = evaluate('US', 'UNKNOWN');
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('JURISDICTION_US_POSTAL_ADDRESS_REQUIRED');
  });

  it('FR 无同意记录可发（CNIL B2B 合法利益），但必须带来源说明页脚', () => {
    const decision = evaluate('FR', 'UNKNOWN', { frSourceNotice: FR_NOTICE });
    expect(decision.allowed).toBe(true);
    expect(decision.policy).toBe('OPT_OUT');
    expect(decision.footerLines).toContain(FR_NOTICE);
  });

  it('负向：FR 未配置来源说明时拒绝 — JURISDICTION_FR_SOURCE_NOTICE_REQUIRED', () => {
    const decision = evaluate('FR', 'UNKNOWN');
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('JURISDICTION_FR_SOURCE_NOTICE_REQUIRED');
  });

  it('负向：任何法域的 OPT_OUT 都永久压制 — OUTREACH_OPTED_OUT', () => {
    expect(evaluate('US', 'OPT_OUT', { usPostalAddress: US_ADDRESS }).code).toBe(
      'OUTREACH_OPTED_OUT',
    );
    expect(evaluate('DE', 'OPT_OUT').code).toBe('OUTREACH_OPTED_OUT');
    expect(evaluate('FR', 'OPT_OUT', { frSourceNotice: FR_NOTICE }).code).toBe(
      'OUTREACH_OPTED_OUT',
    );
  });

  it('负向：未知国家（缺失/非法值）默认 REVIEW_REQUIRED，不发', () => {
    expect(evaluate(undefined, 'OPT_IN').code).toBe('JURISDICTION_REVIEW_REQUIRED');
    expect(evaluate('IT', 'OPT_IN').code).toBe('JURISDICTION_REVIEW_REQUIRED');
    expect(evaluate('FRANCE', 'OPT_IN').code).toBe('JURISDICTION_REVIEW_REQUIRED');
  });

  it('国家代码大小写与空白归一化', () => {
    expect(evaluate(' de ', 'OPT_IN').allowed).toBe(true);
    expect(evaluate('us', 'UNKNOWN', { usPostalAddress: US_ADDRESS }).allowed).toBe(true);
  });
});

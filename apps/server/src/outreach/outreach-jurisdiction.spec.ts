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

describe('outreachJurisdictionPolicy（D3 全球法域矩阵）', () => {
  it('DE/AT/CH/CA/AE/SA 要求同意，US/FR/IT/ES/NL/BR 等合法 ISO 法域走反对制，缺失/未知/禁运法域人工复核', () => {
    expect(outreachJurisdictionPolicy('DE')).toBe('CONSENT_REQUIRED');
    expect(outreachJurisdictionPolicy('at')).toBe('CONSENT_REQUIRED');
    expect(outreachJurisdictionPolicy('CH')).toBe('CONSENT_REQUIRED');
    expect(outreachJurisdictionPolicy('US')).toBe('OPT_OUT');
    expect(outreachJurisdictionPolicy('FR')).toBe('OPT_OUT');
    expect(outreachJurisdictionPolicy('IT')).toBe('OPT_OUT');
    expect(outreachJurisdictionPolicy('ES')).toBe('OPT_OUT');
    expect(outreachJurisdictionPolicy('NL')).toBe('OPT_OUT');
    expect(outreachJurisdictionPolicy('BR')).toBe('OPT_OUT');
    expect(outreachJurisdictionPolicy('ZZ')).toBe('REVIEW_REQUIRED');
    expect(outreachJurisdictionPolicy('KP')).toBe('REVIEW_REQUIRED');
    expect(outreachJurisdictionPolicy('IR')).toBe('REVIEW_REQUIRED');
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

  it('负向：未知国家（缺失/非法值/禁运国）默认 REVIEW_REQUIRED，不发；IT/ES/NL 按 D3 OPT_OUT 放行', () => {
    expect(evaluate(undefined, 'OPT_IN').code).toBe('JURISDICTION_REVIEW_REQUIRED');
    expect(evaluate('ZZ', 'OPT_IN').code).toBe('JURISDICTION_REVIEW_REQUIRED');
    expect(evaluate('KP', 'OPT_IN').code).toBe('JURISDICTION_REVIEW_REQUIRED');
    expect(evaluate('FRANCE', 'OPT_IN').code).toBe('JURISDICTION_REVIEW_REQUIRED');
    const itDecision = evaluate('IT', 'MISSING');
    expect(itDecision.allowed).toBe(true);
    expect(itDecision.policy).toBe('OPT_OUT');
    expect(evaluate('ES', 'UNKNOWN').allowed).toBe(true);
    expect(evaluate('NL', 'UNKNOWN').allowed).toBe(true);
  });

  it('国家代码大小写与空白归一化', () => {
    expect(evaluate(' de ', 'OPT_IN').allowed).toBe(true);
    expect(evaluate('us', 'UNKNOWN', { usPostalAddress: US_ADDRESS }).allowed).toBe(true);
  });

  it('D3 补齐：CA/AE/SA 强制 CONSENT_REQUIRED；UK PECR 按法人后缀放行企业、拦个体户', () => {
    for (const cc of ['CA', 'AE', 'SA']) {
      expect(outreachJurisdictionPolicy(cc)).toBe('CONSENT_REQUIRED');
      expect(evaluate(cc, 'MISSING').code).toBe('JURISDICTION_CONSENT_REQUIRED');
      expect(evaluate(cc, 'OPT_IN').allowed).toBe(true);
    }
    expect(
      evaluateEmailJurisdiction({ countryCode: 'GB', consentStatus: 'UNKNOWN', companyName: 'SunGrid Solar Ltd' }).allowed,
    ).toBe(true);
    expect(
      evaluateEmailJurisdiction({ countryCode: 'GB', consentStatus: 'UNKNOWN', companyName: 'John Smith Solar' }).code,
    ).toBe('JURISDICTION_CONSENT_REQUIRED');
  });
});

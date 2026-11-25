import { describe, expect, it } from 'vitest';
import {
  buildLinkedInIcebreaker,
  buildMailtoHref,
  buildWhatsappHref,
  evaluateT0Channels,
  isKnownIsoCountry,
  isUkCorporateSubscriber,
  maskEmailLocalPart,
  normalizeCountryCode,
  normalizeWebsiteUrl,
  resolveD3JurisdictionPolicy,
} from './outreach-t0.js';

describe('D3 jurisdiction rules & T0 four-channel policy', () => {
  it('normalizes country codes and recognizes valid ISO alpha-2 countries while failing closed on unknown/embargoed', () => {
    expect(normalizeCountryCode(' it ')).toBe('IT');
    expect(normalizeCountryCode(undefined)).toBe('');
    expect(isKnownIsoCountry('IT')).toBe(true);
    expect(isKnownIsoCountry('BR')).toBe(true);
    expect(isKnownIsoCountry('GB')).toBe(true);
    expect(isKnownIsoCountry('UK')).toBe(true);
    expect(isKnownIsoCountry('ZZ')).toBe(false);
    expect(isKnownIsoCountry('FRANCE')).toBe(false);

    expect(resolveD3JurisdictionPolicy('IT')).toBe('OPT_OUT');
    expect(resolveD3JurisdictionPolicy('ES')).toBe('OPT_OUT');
    expect(resolveD3JurisdictionPolicy('NL')).toBe('OPT_OUT');
    expect(resolveD3JurisdictionPolicy('US')).toBe('OPT_OUT');
    expect(resolveD3JurisdictionPolicy('FR')).toBe('OPT_OUT');
    expect(resolveD3JurisdictionPolicy('BR')).toBe('OPT_OUT');

    for (const strictCc of ['DE', 'AT', 'CH', 'CA', 'AE', 'SA']) {
      expect(resolveD3JurisdictionPolicy(strictCc)).toBe('CONSENT_REQUIRED');
    }

    expect(resolveD3JurisdictionPolicy('GB', { companyName: 'SunGrid Solar Ltd' })).toBe('OPT_OUT');
    expect(resolveD3JurisdictionPolicy('GB', { companyName: 'John Smith Solar' })).toBe(
      'CONSENT_REQUIRED',
    );
    expect(resolveD3JurisdictionPolicy('GB')).toBe('REVIEW_REQUIRED');
    expect(resolveD3JurisdictionPolicy(undefined)).toBe('REVIEW_REQUIRED');
    expect(resolveD3JurisdictionPolicy('ZZ')).toBe('REVIEW_REQUIRED');
    expect(resolveD3JurisdictionPolicy('KP')).toBe('REVIEW_REQUIRED');
    expect(resolveD3JurisdictionPolicy('IR')).toBe('REVIEW_REQUIRED');
  });

  it('recognizes UK corporate subscriber suffixes', () => {
    expect(isUkCorporateSubscriber('SunGrid Solar Ltd.')).toBe(true);
    expect(isUkCorporateSubscriber('Alpha Energy PLC')).toBe(true);
    expect(isUkCorporateSubscriber('Thames Partners LLP')).toBe(true);
    expect(isUkCorporateSubscriber('John Smith Trading')).toBe(false);
  });

  it('hard-blocks all 4 T0 channels when suppressed or sanctionsHold is true', () => {
    const suppressed = evaluateT0Channels({
      countryCode: 'IT',
      companyName: 'Refeel Solar S.r.l.',
      email: 'info@refeel.it',
      phone: '+39 02 1234567',
      linkedinUrl: 'https://www.linkedin.com/company/refeel',
      formUrl: 'https://refeel.it/contact',
      suppressed: true,
    });
    expect(suppressed.blockedAll).toBe(true);
    expect(suppressed.blockCode).toBe('SUPPRESSED');
    expect(suppressed.channels.mailto.allowed).toBe(false);
    expect(suppressed.channels.linkedin.allowed).toBe(false);
    expect(suppressed.channels.whatsapp.allowed).toBe(false);
    expect(suppressed.channels.form.allowed).toBe(false);

    const sanctioned = evaluateT0Channels({
      countryCode: 'IR',
      companyName: 'Example Co',
      email: 'info@example.ir',
      linkedinUrl: 'https://www.linkedin.com/company/example',
      formUrl: 'https://example.ir/contact',
    });
    expect(sanctioned.blockedAll).toBe(true);
    expect(sanctioned.blockCode).toBe('SANCTIONS_HOLD');
    expect(sanctioned.channels.mailto.allowed).toBe(false);
    expect(sanctioned.channels.linkedin.allowed).toBe(false);
    expect(sanctioned.channels.whatsapp.allowed).toBe(false);
    expect(sanctioned.channels.form.allowed).toBe(false);
  });

  it('disables mailto in DE/AT/CH/CA/AE/SA without OPT_IN and guides to LinkedIn/form', () => {
    for (const cc of ['DE', 'AT', 'CH', 'CA', 'AE', 'SA']) {
      const result = evaluateT0Channels({
        countryCode: cc,
        companyName: 'Solaris GmbH',
        email: 'sales@solaris.de',
        phone: '+49 89 123456',
        linkedinUrl: 'https://www.linkedin.com/company/solaris',
        formUrl: 'https://solaris.de/kontakt',
      });
      expect(result.blockedAll).toBe(false);
      expect(result.channels.mailto.allowed).toBe(false);
      expect(result.channels.mailto.reasonCode).toBe('JURISDICTION_CONSENT_REQUIRED');
      expect(result.channels.linkedin.allowed).toBe(true);
      expect(result.channels.form.allowed).toBe(true);
      expect(result.channels.whatsapp.allowed).toBe(false);
      expect(result.channels.whatsapp.reasonCode).toBe('JURISDICTION_WHATSAPP_OUTBOUND_BLOCKED');
    }

    const deConsented = evaluateT0Channels({
      countryCode: 'DE',
      companyName: 'Solaris GmbH',
      email: 'sales@solaris.de',
      consentStatus: 'OPT_IN',
    });
    expect(deConsented.channels.mailto.allowed).toBe(true);
  });

  it('enables mailto in IT/EU/US/UK-corporate while keeping WhatsApp restricted to warm whitelist', () => {
    const itResult = evaluateT0Channels({
      countryCode: 'IT',
      companyName: 'Refeel Solar S.r.l.',
      email: 'acquisti@refeel.it',
      phone: '+39 02 1234567',
      formUrl: 'https://refeel.it/contatti',
    });
    expect(itResult.jurisdictionPolicy).toBe('OPT_OUT');
    expect(itResult.channels.mailto.allowed).toBe(true);
    expect(itResult.channels.whatsapp.allowed).toBe(false);
    expect(itResult.channels.whatsapp.reasonCode).toBe('JURISDICTION_WHATSAPP_OUTBOUND_BLOCKED');
    expect(itResult.channels.form.allowed).toBe(true);
    expect(itResult.channels.linkedin.allowed).toBe(true);
    expect(itResult.channels.linkedin.mode).toBe('search');

    const brResult = evaluateT0Channels({
      countryCode: 'BR',
      companyName: 'Sol Brasil Ltda',
      email: 'compras@solbrasil.com.br',
      phone: '+55 (11) 98765-4321',
    });
    expect(brResult.channels.mailto.allowed).toBe(true);
    expect(brResult.channels.whatsapp.allowed).toBe(true);
    expect(brResult.channels.whatsapp.normalizedPhone).toBe('5511987654321');
  });

  it('builds safe mailto, wa.me, LinkedIn icebreaker (<=300 chars), normalized website URL, and masked email', () => {
    const mailto = buildMailtoHref('buyer@refeel.it', 'HJT 700W Modules', 'Hello\nLine 2');
    expect(mailto).toContain('mailto:buyer@refeel.it?');
    expect(mailto).toContain('subject=HJT%20700W%20Modules');
    expect(mailto).toContain('body=Hello%0ALine%202');

    const unsafe = evaluateT0Channels({
      countryCode: 'IT',
      companyName: 'Refeel S.r.l.',
      linkedinUrl: 'javascript:alert(1)',
      formUrl: 'javascript:alert(2)',
    });
    expect(unsafe.channels.form.allowed).toBe(false);
    expect(unsafe.channels.linkedin.mode).toBe('search');

    const wa = buildWhatsappHref('+55 (11) 98765-4321', 'Hello from factory');
    expect(wa).toContain('https://wa.me/5511987654321?text=');
    expect(decodeURIComponent(wa)).toContain('STOP');

    const icebreaker = buildLinkedInIcebreaker({
      companyName: 'A'.repeat(120),
      contactName: 'Maria Rossi',
      body: 'B'.repeat(500),
    });
    expect(icebreaker.length).toBeLessThanOrEqual(300);

    expect(normalizeWebsiteUrl('example.com')).toBe('https://example.com');
    expect(normalizeWebsiteUrl('  www.solar-epc.de/en  ')).toBe('https://www.solar-epc.de/en');
    expect(normalizeWebsiteUrl('http://legacy.example.com')).toBe('http://legacy.example.com');
    expect(normalizeWebsiteUrl('https://ok.example.com')).toBe('https://ok.example.com');
    expect(normalizeWebsiteUrl('')).toBe('');

    expect(maskEmailLocalPart('maria.rossi@solarepc.it')).toBe('m***@solarepc.it');
    expect(maskEmailLocalPart('a@b.de')).toBe('*@b.de');
  });
});

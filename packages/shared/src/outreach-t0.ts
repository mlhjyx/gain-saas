/**
 * D3 法域合规多通道外联规则与 T0 轻外联纯函数（server 与 web 共用，零漂移）。
 * 与引擎 multi-channel-playbook.ts 对齐：
 * - DE / AT / CH / CA / AE / SA：严格同意制（CONSENT_REQUIRED），无显式 OPT_IN 禁止冷邮；
 * - GB / UK：PECR 法人实体（Ltd / Limited / PLC / LLP 等）走 OPT_OUT，个体户/非法人走 CONSENT_REQUIRED；
 * - US / FR / 其余 EU / 合法 ISO 国家：OPT_OUT（SMTP 发送门仍按 US 地址 / FR 来源告知校验页脚）；
 * - 缺失/非法国家代码或禁运国（KP / IR / SY / CU）：REVIEW_REQUIRED（fail-closed）；
 * - 主动外呼 WhatsApp（wa.me）：仅拉美/亚非拉温热白名单市场 + 有效号码 + 非禁联 + 带退订提示时放行；
 * - 禁联（suppressed）或制裁冻结（sanctionsHold）：一票否决全部 4 个 T0 触达动作。
 */

export type D3JurisdictionPolicy = 'CONSENT_REQUIRED' | 'OPT_OUT' | 'REVIEW_REQUIRED';
export type T0ConsentState = 'OPT_IN' | 'OPT_OUT' | 'UNKNOWN' | 'MISSING';
export type T0ChannelKey = 'mailto' | 'linkedin' | 'whatsapp' | 'form';

export const STRICT_CONSENT_COUNTRIES: ReadonlySet<string> = new Set([
  'DE',
  'AT',
  'CH',
  'CA',
  'AE',
  'SA',
]);

export const EMBARGOED_COUNTRIES: ReadonlySet<string> = new Set(['KP', 'IR', 'SY', 'CU']);

export const EU_EEA_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
]);

export const WARM_MANUAL_WHATSAPP_COUNTRIES: ReadonlySet<string> = new Set([
  'BR', 'MX', 'CO', 'CL', 'PE', 'AR', 'IN', 'ID', 'MY', 'TH', 'VN', 'PH', 'ZA',
]);

/** 标准 ISO 3166-1 alpha-2（含 UK 别名，剔除禁运国与保留测试码 XX/ZZ）。 */
const KNOWN_ISO_COUNTRIES: ReadonlySet<string> = new Set([
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ',
  'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CV', 'CW', 'CX', 'CY', 'CZ',
  'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ',
  'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET',
  'FI', 'FJ', 'FK', 'FM', 'FO', 'FR',
  'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY',
  'HK', 'HM', 'HN', 'HR', 'HT', 'HU',
  'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IS', 'IT',
  'JE', 'JM', 'JO', 'JP',
  'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KR', 'KW', 'KY', 'KZ',
  'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY',
  'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ',
  'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ',
  'OM',
  'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY',
  'QA',
  'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SZ',
  'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ',
  'UA', 'UG', 'UK', 'UM', 'US', 'UY', 'UZ',
  'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU',
  'WF', 'WS',
  'YE', 'YT',
  'ZA', 'ZM', 'ZW',
]);

const UK_CORPORATE_SUFFIX_RE =
  /\b(?:ltd\.?|limited|plc|p\.l\.c\.|llp|l\.l\.p\.|lp|cic|cio|inc\.?|corp\.?)\b/i;

const EMAIL_SIMPLE_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function normalizeCountryCode(countryCode: unknown): string {
  return typeof countryCode === 'string' ? countryCode.trim().toUpperCase() : '';
}

export function isKnownIsoCountry(countryCode: unknown): boolean {
  const cc = normalizeCountryCode(countryCode);
  return cc.length === 2 && KNOWN_ISO_COUNTRIES.has(cc);
}

export function isUkCorporateSubscriber(companyName?: string | null): boolean {
  return typeof companyName === 'string' && UK_CORPORATE_SUFFIX_RE.test(companyName.trim());
}

export function resolveD3JurisdictionPolicy(
  countryCode: unknown,
  opts?: { companyName?: string | null },
): D3JurisdictionPolicy {
  const country = normalizeCountryCode(countryCode);
  if (!country || country.length !== 2 || EMBARGOED_COUNTRIES.has(country)) {
    return 'REVIEW_REQUIRED';
  }
  if (STRICT_CONSENT_COUNTRIES.has(country)) {
    return 'CONSENT_REQUIRED';
  }
  if (country === 'GB' || country === 'UK') {
    if (opts?.companyName !== undefined) {
      return isUkCorporateSubscriber(opts.companyName) ? 'OPT_OUT' : 'CONSENT_REQUIRED';
    }
    return 'REVIEW_REQUIRED';
  }
  if (KNOWN_ISO_COUNTRIES.has(country)) {
    return 'OPT_OUT';
  }
  return 'REVIEW_REQUIRED';
}

export function isSafeHttpUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function isSafeLinkedinUrl(raw: unknown): raw is string {
  if (!isSafeHttpUrl(raw)) return false;
  try {
    const host = new URL(raw.trim()).hostname.toLowerCase();
    return host === 'linkedin.com' || host.endsWith('.linkedin.com');
  } catch {
    return false;
  }
}

export function normalizeWebsiteUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/+/, '')}`;
}

export function normalizePhoneDigits(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const waMatch = /(?:wa\.me\/|api\.whatsapp\.com\/send\?[^#]*phone=)(\+?\d[\d\s\-()]{5,20})/i.exec(
    trimmed,
  );
  const candidate = waMatch ? waMatch[1]! : trimmed;
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

export function maskEmailLocalPart(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.indexOf('@');
  if (at <= 0) return '***';
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (local.length <= 1) return `*@${domain}`;
  return `${local[0]}***@${domain}`;
}

export function buildMailtoHref(email: string, subject: string, body: string): string | null {
  const clean = email.trim().replace(/[\r\n]/g, '');
  if (!EMAIL_SIMPLE_RE.test(clean)) return null;
  const params = [
    `subject=${encodeURIComponent(subject.trim())}`,
    `body=${encodeURIComponent(body.trim())}`,
  ].join('&');
  return `mailto:${clean}?${params}`;
}

export const WHATSAPP_OPTOUT_FOOTER = 'Reply STOP if you prefer not to hear from us.';

export function buildWhatsappHref(phoneOrUrl: string, message: string): string | null {
  const digits = normalizePhoneDigits(phoneOrUrl);
  if (!digits) return null;
  const trimmed = message.trim();
  const hasOptOut = /\bstop\b|退订|opt[\s-]?out/i.test(trimmed);
  const text = trimmed
    ? hasOptOut
      ? trimmed
      : `${trimmed}\n\n${WHATSAPP_OPTOUT_FOOTER}`
    : WHATSAPP_OPTOUT_FOOTER;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

export function buildLinkedInIcebreaker(input: {
  companyName?: string | null;
  contactName?: string | null;
  body?: string | null;
}): string {
  const contact = (input.contactName ?? '').trim();
  const company = (input.companyName ?? '').trim();
  const rawBody = (input.body ?? '').replace(/\s+/g, ' ').trim();
  const greeting = contact ? `Hi ${contact}, ` : company ? `Hi ${company} team, ` : 'Hi, ';
  const core =
    rawBody ||
    (company
      ? `reaching out regarding B2B supply collaboration with ${company}. Happy to share specs and lead times.`
      : 'reaching out regarding B2B supply collaboration. Happy to share product specs and lead times.');
  const combined = rawBody.toLowerCase().startsWith('hi ') || rawBody.toLowerCase().startsWith('hello')
    ? rawBody
    : `${greeting}${core}`;
  if (combined.length <= 300) return combined;
  return `${combined.slice(0, 297).trimEnd()}...`;
}

export interface T0ChannelEvaluationInput {
  countryCode?: string | null;
  companyName?: string | null;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  whatsappUrl?: string | null;
  linkedinUrl?: string | null;
  formUrl?: string | null;
  consentStatus?: T0ConsentState;
  suppressed?: boolean;
  sanctionsHold?: boolean;
  dncCheckFailed?: boolean;
}

export interface T0ChannelVerdict {
  allowed: boolean;
  reasonCode: string | null;
}

export interface T0LinkedInVerdict extends T0ChannelVerdict {
  mode: 'direct' | 'search';
  url: string | null;
}

export interface T0WhatsappVerdict extends T0ChannelVerdict {
  normalizedPhone: string | null;
}

export interface T0FormVerdict extends T0ChannelVerdict {
  url: string | null;
}

export interface T0EvaluationResult {
  countryCode: string;
  jurisdictionPolicy: D3JurisdictionPolicy;
  blockedAll: boolean;
  blockCode: 'SUPPRESSED' | 'SANCTIONS_HOLD' | 'DNC_UNAVAILABLE' | null;
  complianceTag: string;
  recommendedSequence: readonly T0ChannelKey[];
  channels: {
    mailto: T0ChannelVerdict;
    linkedin: T0LinkedInVerdict;
    whatsapp: T0WhatsappVerdict;
    form: T0FormVerdict;
  };
}

export function evaluateT0Channels(input: T0ChannelEvaluationInput): T0EvaluationResult {
  const countryCode = normalizeCountryCode(input.countryCode);
  const consentStatus = input.consentStatus ?? 'MISSING';
  const companyName = input.companyName ?? '';
  const policy = resolveD3JurisdictionPolicy(
    countryCode,
    companyName ? { companyName } : input.companyName !== undefined ? { companyName: input.companyName } : undefined,
  );

  const isSanctioned = Boolean(input.sanctionsHold) || EMBARGOED_COUNTRIES.has(countryCode);
  const isSuppressed = Boolean(input.suppressed) || consentStatus === 'OPT_OUT';
  const dncFailed = Boolean(input.dncCheckFailed);

  const directProfileUrl = isSafeLinkedinUrl(input.linkedinUrl)
    ? input.linkedinUrl.trim()
    : null;
  const profileSearchQuery = [input.contactName, input.companyName]
    .filter(Boolean)
    .join(' ')
    .trim();
  const fallbackSearchUrl = profileSearchQuery
    ? `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(profileSearchQuery)}`
    : null;
  const safeFormUrl = isSafeHttpUrl(input.formUrl) ? input.formUrl.trim() : null;
  const normalizedPhone =
    normalizePhoneDigits(input.whatsappUrl) ?? normalizePhoneDigits(input.phone);

  if (isSanctioned || isSuppressed || dncFailed) {
    const blockCode = isSanctioned
      ? 'SANCTIONS_HOLD'
      : isSuppressed
        ? 'SUPPRESSED'
        : 'DNC_UNAVAILABLE';
    return {
      countryCode,
      jurisdictionPolicy: policy,
      blockedAll: true,
      blockCode,
      complianceTag: `${countryCode || 'UNKNOWN'}:${blockCode}`,
      recommendedSequence: [],
      channels: {
        mailto: { allowed: false, reasonCode: blockCode },
        linkedin: {
          allowed: false,
          reasonCode: blockCode,
          mode: directProfileUrl ? 'direct' : 'search',
          url: null,
        },
        whatsapp: { allowed: false, reasonCode: blockCode, normalizedPhone: null },
        form: { allowed: false, reasonCode: blockCode, url: null },
      },
    };
  }

  const cleanEmail = (input.email ?? '').trim();
  const hasValidEmail = EMAIL_SIMPLE_RE.test(cleanEmail);
  let mailto: T0ChannelVerdict;
  if (!hasValidEmail) {
    mailto = { allowed: false, reasonCode: 'NO_EMAIL' };
  } else if (policy === 'CONSENT_REQUIRED' && consentStatus !== 'OPT_IN') {
    mailto = { allowed: false, reasonCode: 'JURISDICTION_CONSENT_REQUIRED' };
  } else if (policy === 'REVIEW_REQUIRED') {
    mailto = { allowed: false, reasonCode: 'JURISDICTION_REVIEW_REQUIRED' };
  } else {
    mailto = { allowed: true, reasonCode: null };
  }

  const resolvedProfileUrl = directProfileUrl ?? fallbackSearchUrl;
  const linkedin: T0LinkedInVerdict = resolvedProfileUrl
    ? {
        allowed: true,
        reasonCode: null,
        mode: directProfileUrl ? 'direct' : 'search',
        url: resolvedProfileUrl,
      }
    : {
        allowed: false,
        reasonCode: 'NO_LINKEDIN_TARGET',
        mode: 'search',
        url: null,
      };

  let whatsapp: T0WhatsappVerdict;
  if (!WARM_MANUAL_WHATSAPP_COUNTRIES.has(countryCode)) {
    whatsapp = {
      allowed: false,
      reasonCode: 'JURISDICTION_WHATSAPP_OUTBOUND_BLOCKED',
      normalizedPhone,
    };
  } else if (!normalizedPhone) {
    whatsapp = {
      allowed: false,
      reasonCode: 'NO_PHONE_OR_WHATSAPP',
      normalizedPhone: null,
    };
  } else {
    whatsapp = {
      allowed: true,
      reasonCode: null,
      normalizedPhone,
    };
  }

  const form: T0FormVerdict = safeFormUrl
    ? { allowed: true, reasonCode: null, url: safeFormUrl }
    : { allowed: false, reasonCode: 'NO_FORM_URL', url: null };

  const strictDachOrConsent = policy === 'CONSENT_REQUIRED' && consentStatus !== 'OPT_IN';
  const recommendedSequence: T0ChannelKey[] = strictDachOrConsent
    ? ['linkedin', 'form']
    : WARM_MANUAL_WHATSAPP_COUNTRIES.has(countryCode)
      ? ['mailto', 'whatsapp', 'linkedin', 'form']
      : ['mailto', 'linkedin', 'form'];

  const complianceTag = strictDachOrConsent
    ? `${countryCode || 'UNKNOWN'}:CONSENT_REQUIRED`
    : policy === 'REVIEW_REQUIRED'
      ? `${countryCode || 'UNKNOWN'}:REVIEW_REQUIRED`
      : countryCode === 'GB' || countryCode === 'UK'
        ? 'UK:PECR_CORPORATE_LI+ART14'
        : EU_EEA_COUNTRIES.has(countryCode)
          ? `${countryCode}:GDPR_LI+ART14`
          : countryCode === 'US'
            ? 'US:CAN_SPAM_FOOTER'
            : WARM_MANUAL_WHATSAPP_COUNTRIES.has(countryCode)
              ? `${countryCode}:B2B_FOOTER+WA_MANUAL_4GUARD`
              : `${countryCode}:B2B_FOOTER`;

  return {
    countryCode,
    jurisdictionPolicy: policy,
    blockedAll: false,
    blockCode: null,
    complianceTag,
    recommendedSequence,
    channels: { mailto, linkedin, whatsapp, form },
  };
}

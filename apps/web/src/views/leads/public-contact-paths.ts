import type { LeadPackage } from '#/api/gainos';

import { evaluateT0Channels, isSafeLinkedinUrl, normalizePhoneDigits } from '@gain-saas/shared';

const websiteContactKinds = new Set(['contact_form', 'contact_page', 'impressum_page', 'supplier_page']);
const hosts = new Map([
  ['facebook', ['facebook.com']],
  ['instagram', ['instagram.com']],
  ['whatsapp', ['whatsapp.com', 'wa.me']],
  ['x', ['x.com', 'twitter.com']],
  ['youtube', ['youtube.com', 'youtu.be']],
]);

export function hasPublicContactAccess(pkg: LeadPackage): boolean {
  return pkg.status !== 'SUPPRESSED' &&
    !['potential_match', 'confirmed_true_hit'].includes(pkg.sanctions?.status ?? '');
}

export function canUseContactPoint(status?: string): boolean {
  return !['BLOCKED', 'INVALID', 'RISKY'].includes(status?.toUpperCase() ?? '');
}

export function safePublicUrl(value?: string | null): string {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.hostname && !parsed.username && !parsed.password
      ? parsed.href
      : '';
  } catch {
    return '';
  }
}

export function publicSocialUrl(platform: string, value: string): string {
  const url = safePublicUrl(value);
  if (!url) return '';
  if (platform === 'linkedin' && !isSafeLinkedinUrl(url)) return '';
  const allowedHosts = hosts.get(platform);
  const hostname = new URL(url).hostname;
  if (allowedHosts && !allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return '';
  return url;
}

export function contactEmailHref(lead: LeadPackage, value: string): string {
  if (!hasPublicContactAccess(lead)) return '';
  const email = value.trim();
  const allowed = evaluateT0Channels({
    companyName: lead.company.name,
    countryCode: lead.company.country,
    email,
  }).channels.mailto.allowed;
  if (!allowed) return '';
  return 'mailto:' + encodeURIComponent(email).replace('%40', '@');
}

export function contactPhoneHref(value: string): string {
  const phone = value.trim();
  if (!/^\+?[0-9 ().-]+$/.test(phone)) return '';
  const digits = normalizePhoneDigits(phone);
  return digits ? 'tel:' + (phone.startsWith('+') ? '+' : '') + digits : '';
}

export function focusContactChannel(id: string): void {
  const card = document.getElementById(id);
  card?.scrollIntoView({ block: 'nearest' });
  card?.focus({ preventScroll: true });
}

export function companyContactPaths(pkg: LeadPackage) {
  if (!hasPublicContactAccess(pkg)) return [];
  const paths = new Map<string, { sourceUrl?: string; status?: string; url: string }>();
  for (const item of pkg.company_channels ?? []) {
    if (item.channel !== 'form_url' || ['BLOCKED', 'INVALID'].includes(item.status)) continue;
    const url = safePublicUrl(item.value);
    if (url) paths.set(url, { sourceUrl: safePublicUrl(item.source_url), status: item.status, url });
  }
  for (const item of pkg.contact_points ?? []) {
    if (!websiteContactKinds.has(item.kind) || ['BLOCKED', 'INVALID'].includes(item.status)) continue;
    const url = safePublicUrl(item.url);
    if (url && !paths.has(url)) paths.set(url, { status: item.status, url });
  }
  return [...paths.values()];
}

export function companyPublicProfiles(pkg: LeadPackage) {
  if (!hasPublicContactAccess(pkg)) return [];
  const source = [...(pkg.social_profiles ?? [])];
  for (const point of pkg.contact_points ?? []) {
    if (point.kind === 'linkedin_company_page' && !['BLOCKED', 'INVALID'].includes(point.status)) {
      source.push({ platform: 'linkedin', url: point.url });
    }
  }
  const profiles = new Map<string, { platform: string; source?: string; url: string }>();
  for (const item of source) {
    const name = item.platform.trim().toLowerCase();
    const platform = name === 'twitter' ? 'x' : name;
    const url = publicSocialUrl(platform, item.url);
    if (!platform || !url) continue;
    const key = `${platform}:${url}`;
    if (item.source || !profiles.has(key)) profiles.set(key, { platform, source: item.source, url });
  }
  return [...profiles.values()];
}

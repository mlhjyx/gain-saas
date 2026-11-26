import type { LeadPackage } from '#/api/gainos';

import { isSafeLinkedinUrl } from '@gain-saas/shared';

const websiteContactKinds = new Set(['contact_form', 'contact_page', 'impressum_page', 'supplier_page']);
const hosts: Record<string, string[]> = {
  facebook: ['facebook.com'],
  whatsapp: ['whatsapp.com', 'wa.me'],
  x: ['x.com', 'twitter.com'],
};

export function hasPublicContactAccess(pkg: LeadPackage): boolean {
  return pkg.status !== 'SUPPRESSED' &&
    !['potential_match', 'confirmed_true_hit'].includes(pkg.sanctions?.status ?? '');
}

function publicUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.href
      : '';
  } catch {
    return '';
  }
}

export function companyContactPaths(pkg: LeadPackage) {
  if (!hasPublicContactAccess(pkg)) return [];
  const paths = new Map<string, { status?: string; url: string }>();
  for (const item of pkg.company_channels ?? []) {
    if (item.channel !== 'form_url' || !item.value) continue;
    const url = publicUrl(item.value);
    if (url) paths.set(url, { url });
  }
  for (const item of pkg.contact_points ?? []) {
    if (!websiteContactKinds.has(item.kind) || ['BLOCKED', 'INVALID'].includes(item.status)) continue;
    const url = publicUrl(item.url);
    if (url) paths.set(url, { status: item.status, url });
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
  const profiles = new Map<string, { platform: string; url: string }>();
  for (const item of source) {
    const name = item.platform.trim().toLowerCase();
    const platform = name === 'twitter' ? 'x' : name;
    const url = publicUrl(item.url);
    if (!platform || !url) continue;
    if (platform === 'linkedin' && !isSafeLinkedinUrl(url)) continue;
    const allowedHosts = hosts[platform];
    const hostname = new URL(url).hostname;
    if (allowedHosts && !allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) continue;
    profiles.set(`${platform}:${url}`, { platform, url });
  }
  return [...profiles.values()];
}

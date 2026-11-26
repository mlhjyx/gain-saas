import type { LocationQuery, RouteLocationGeneric, RouteRecordRaw } from 'vue-router';

/**
 * 历史深链兜底（v3.0 P5b-17 / G10 & Wave B2）：被删除或合并的路由保留 redirect ≥2 个发布版本。
 * 只做跳转、不渲染页面；不进菜单与标签页。
 */
export const LEGACY_REDIRECTS: Array<{ name: string; path: string; to: string }> = [
  { name: 'LegacyDashboard', path: '/dashboard', to: '/workspace' },
  {
    name: 'LegacyDashboardAnalytics',
    path: '/dashboard/analytics',
    to: '/workspace',
  },
  { name: 'LegacyDemos', path: '/demos', to: '/workspace' },
  { name: 'LegacyDemosAntd', path: '/demos/antd', to: '/workspace' },
  { name: 'LegacyProfile', path: '/profile', to: '/settings/members' },
  { name: 'LegacyAbout', path: '/about', to: '/workspace' },
  {
    name: 'LegacySettingsWorkspaces',
    path: '/settings/workspaces',
    to: '/settings/members',
  },
  { name: 'LegacyCampaigns', path: '/campaigns', to: '/outreach?tab=campaigns' },
  {
    name: 'LegacyCampaignDetail',
    path: '/campaigns/:campaignId',
    to: '/outreach/campaigns/:campaignId',
  },
  { name: 'LegacyQgos', path: '/qgos', to: '/opportunities' },
  { name: 'LegacyReports', path: '/reports', to: '/analytics' },
];

/**
 * `/growth` 按 `?tab=` 精确分流表（Wave B2 拆解原杂烩页，保留 ≥2 个发布版本）。
 * 缺失或未知 `?tab=` 回退到 `campaigns`（`/outreach?tab=campaigns`），其余查询参数原样透传。
 */
export const LEGACY_GROWTH_TAB_REDIRECTS: Record<string, string> = {
  campaigns: '/outreach?tab=campaigns',
  outreach: '/outreach?tab=batches',
  replies: '/outreach?tab=replies',
  opportunities: '/opportunities',
  reviews: '/leads?view=reviews',
  metrics: '/analytics',
};

const REDIRECT_META = {
  hideInBreadcrumb: true,
  hideInMenu: true,
  hideInTab: true,
  title: 'Redirect',
} as const;

function resolveLegacyTarget(
  template: string,
  from: RouteLocationGeneric,
  stripQueryKeys: string[] = [],
) {
  const [rawPath = '/', rawQuery = ''] = template.split('?');
  const resolvedPath = rawPath.replace(/:([A-Za-z0-9_]+)/g, (_match, paramName: string) => {
    const rawParam = from.params[paramName];
    const value = Array.isArray(rawParam) ? rawParam[0] : rawParam;
    return encodeURIComponent(String(value ?? ''));
  });

  const stripSet = new Set(stripQueryKeys);
  const query: LocationQuery = {};
  for (const [key, value] of Object.entries(from.query)) {
    if (!stripSet.has(key)) {
      query[key] = value;
    }
  }
  if (rawQuery) {
    const targetParams = new URLSearchParams(rawQuery);
    for (const [key, value] of targetParams.entries()) {
      query[key] = value;
    }
  }

  return {
    hash: from.hash,
    path: resolvedPath,
    query,
  };
}

const staticRedirectRoutes: RouteRecordRaw[] = LEGACY_REDIRECTS.map(({ name, path, to }) => ({
  meta: REDIRECT_META,
  name,
  path,
  redirect: (from) => resolveLegacyTarget(to, from),
}));

const growthRedirectRoute: RouteRecordRaw = {
  meta: REDIRECT_META,
  name: 'LegacyGrowth',
  path: '/growth',
  redirect: (from) => {
    const rawTab = Array.isArray(from.query.tab) ? from.query.tab[0] : from.query.tab;
    const key =
      typeof rawTab === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_GROWTH_TAB_REDIRECTS, rawTab)
        ? rawTab
        : 'campaigns';
    return resolveLegacyTarget(LEGACY_GROWTH_TAB_REDIRECTS[key]!, from, ['tab']);
  },
};

const routes: RouteRecordRaw[] = [...staticRedirectRoutes, growthRedirectRoute];

export default routes;

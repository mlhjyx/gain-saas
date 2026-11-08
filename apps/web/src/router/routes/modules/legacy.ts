import type { RouteRecordRaw } from 'vue-router';

/**
 * 历史深链兜底（v3.0 P5b-17 / G10）：被删除或合并的路由保留 redirect ≥2 个发布版本。
 * 只做跳转、不渲染页面；不进菜单与标签页。
 */
const LEGACY_REDIRECTS: Array<{ name: string; path: string; to: string }> = [
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
];

const routes: RouteRecordRaw[] = LEGACY_REDIRECTS.map(({ name, path, to }) => ({
  name,
  path,
  redirect: to,
  meta: {
    hideInBreadcrumb: true,
    hideInMenu: true,
    hideInTab: true,
    title: 'Redirect',
  },
}));

export default routes;

import type { RouteRecordRaw } from 'vue-router';

import { GROWTH_PAGE_HIDDEN } from '#/feature-flags';

import { navTitle } from '../nav';

/**
 * 成效复盘与度量（归属「触达与转化」组，与外发与战役、商机管线统一受 GROWTH_PAGE_HIDDEN 门控）。
 * 直接深链 /analytics 与历史 /reports、/growth?tab=metrics 重定向始终 100% 可达。
 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      hideInMenu: GROWTH_PAGE_HIDDEN,
      icon: 'lucide:bar-chart-3',
      order: 9,
      title: navTitle('analytics'),
    },
    name: 'Analytics',
    path: '/analytics',
    component: () => import('#/views/metrics/index.vue'),
  },
];

export default routes;

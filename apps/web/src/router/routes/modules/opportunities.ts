import type { RouteRecordRaw } from 'vue-router';

import { GROWTH_PAGE_HIDDEN } from '#/feature-flags';

import { navTitle } from '../nav';

/**
 * 商机管线（Wave B2「3 组 8 项」一级入口，归属「触达与转化」组）。
 * 受 GROWTH_PAGE_HIDDEN 统一控制侧栏显隐；深链 /opportunities 与历史 /qgos 重定向均可达。
 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      hideInMenu: GROWTH_PAGE_HIDDEN,
      icon: 'lucide:handshake',
      order: 8,
      title: navTitle('opportunities'),
    },
    name: 'Opportunities',
    path: '/opportunities',
    component: () => import('#/views/qgos/index.vue'),
  },
];

export default routes;

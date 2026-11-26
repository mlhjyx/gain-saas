import type { RouteRecordRaw } from 'vue-router';

import { GROWTH_PAGE_HIDDEN } from '#/feature-flags';
import { $t } from '#/locales';

import { navTitle } from '../nav';

/**
 * 外发与战役（Wave B2「3 组 8 项」一级入口，归属「触达与转化」组）。
 *
 * - 受 GROWTH_PAGE_HIDDEN 统一控制侧栏显隐；即使隐藏，深链 /outreach 与
 *   /outreach/campaigns/:campaignId 仍照常可达。
 * - fullPathKey: false：?tab=campaigns|batches|replies 只是视图状态，切 tab 不重挂载。
 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      fullPathKey: false,
      hideInMenu: GROWTH_PAGE_HIDDEN,
      icon: 'lucide:send',
      order: 7,
      title: navTitle('outreach'),
    },
    name: 'Outreach',
    path: '/outreach',
    component: () => import('#/views/outreach/hub.vue'),
  },
  {
    meta: {
      activePath: '/outreach',
      hideInMenu: true,
      title: $t('gainos.menu.campaigns'),
    },
    name: 'CampaignDetail',
    path: '/outreach/campaigns/:campaignId',
    component: () => import('#/views/campaigns/detail.vue'),
  },
];

export default routes;

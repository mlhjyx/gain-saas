import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

/**
 * M2.1 审批 UI（docs/superpowers/plans/2026-11-08-campaign-planner-m2-1.md §4.3）：
 * Campaign 列表 / 详情（计划摘要 + 版本时间线 + 审批卡 + Why 卡三层渐进 + 影子期横幅）。
 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:target',
      order: 6,
      title: $t('gainos.menu.campaigns'),
    },
    name: 'Campaigns',
    path: '/campaigns',
    component: () => import('#/views/campaigns/index.vue'),
  },
  {
    meta: {
      hideInMenu: true,
      title: $t('gainos.menu.campaigns'),
    },
    name: 'CampaignDetail',
    path: '/campaigns/:campaignId',
    component: () => import('#/views/campaigns/detail.vue'),
  },
];

export default routes;

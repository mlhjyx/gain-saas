import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

/**
 * M2.1 审批 UI（docs/superpowers/plans/2026-11-08-campaign-planner-m2-1.md §4.3）：
 * Campaign 列表 / 详情（计划摘要 + 版本时间线 + 审批卡 + Why 卡三层渐进 + 影子期横幅）。
 *
 * 入口归属（M2 步 14-1）：本页不占一级导航（m2-1 设计 A5、步 14 设计 D-14-a 六项导航）——
 * 列表路由 hideInMenu，入口在「商机与触达 → 战役计划」tab；深链 /campaigns 照常可达。
 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      hideInMenu: true,
      icon: 'lucide:target',
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

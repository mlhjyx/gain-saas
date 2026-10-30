import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

/** 主链路 IA(PRD §14.1):找买家 / 买家线索 / 周报。M2 期间为阶段页。 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:radar',
      order: 3,
      title: $t('gainos.menu.findBuyers'),
    },
    name: 'FindBuyers',
    path: '/find-buyers',
    component: () => import('#/views/find-buyers/index.vue'),
  },
  {
    meta: {
      hideInMenu: true,
      title: $t('gainos.runs.title'),
    },
    name: 'DiscoveryRun',
    path: '/runs/:runId',
    component: () => import('#/views/runs/index.vue'),
  },
  {
    meta: {
      icon: 'lucide:users',
      order: 4,
      title: $t('gainos.menu.leads'),
    },
    name: 'Leads',
    path: '/leads',
    component: () => import('#/views/leads/index.vue'),
  },
  {
    meta: {
      icon: 'lucide:calendar-check',
      order: 5,
      title: $t('gainos.menu.reports'),
    },
    name: 'WeeklyReport',
    path: '/reports',
    component: () => import('#/views/reports/index.vue'),
  },
];

export default routes;

import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

import { navTitle } from '../nav';

/** 主链路 IA（M2 步 14 六项导航）：找买家 / 买家线索；任务详情收编为隐藏路由。 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:radar',
      order: 3,
      title: navTitle('findBuyers'),
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
      order: 5,
      title: navTitle('leads'),
    },
    name: 'Leads',
    path: '/leads',
    component: () => import('#/views/leads/index.vue'),
  },
  {
    // v3.0 P5b-08：线索档案包整页（?tab=package|people|draft|outcomes 可分享）。
    // fullPathKey:false——tab 只是查询参数的视图状态：默认按 fullPath 作页面 key 会让
    // 每次 tab 切换整页重挂载（重播路由过渡 + 重新拉档案包），观感是"闪一下"。
    meta: {
      fullPathKey: false,
      hideInMenu: true,
      title: $t('gainos.leads.packageTitle'),
    },
    name: 'LeadDetail',
    path: '/leads/:leadId',
    component: () => import('#/views/leads/detail.vue'),
  },
  {
    // M2 步 10：商机列表（不占 P6 导航；入口在线索页，路由隐藏于菜单）。
    meta: {
      hideInMenu: true,
      title: $t('gainos.qgos.title'),
    },
    name: 'Qgos',
    path: '/qgos',
    component: () => import('#/views/qgos/index.vue'),
  },
];

export default routes;

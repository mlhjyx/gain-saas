import type { RouteRecordRaw } from 'vue-router';

import { navTitle } from '../nav';

/** 获客与筛选域（Wave B2「3 组 8 项」）：买家画像 / 买家线索；详情与运行记录为隐藏路由并挂靠主菜单高亮。 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:radar',
      order: 4,
      title: navTitle('findBuyers'),
    },
    name: 'FindBuyers',
    path: '/find-buyers',
    component: () => import('#/views/find-buyers/index.vue'),
  },
  {
    meta: {
      activePath: '/tasks',
      hideInMenu: true,
      title: 'gainos.runs.title',
    },
    name: 'DiscoveryRun',
    path: '/runs/:runId',
    component: () => import('#/views/runs/index.vue'),
  },
  {
    meta: {
      fullPathKey: false,
      icon: 'lucide:users',
      order: 6,
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
      activePath: '/leads',
      fullPathKey: false,
      hideInMenu: true,
      title: 'gainos.leads.packageTitle',
    },
    name: 'LeadDetail',
    path: '/leads/:leadId',
    component: () => import('#/views/leads/detail.vue'),
  },
];

export default routes;

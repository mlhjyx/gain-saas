import type { RouteRecordRaw } from 'vue-router';

import { navTitle } from '../nav';

/**
 * 「商机与触达」合并入口（P6 设计 D-14-a）：一个一级导航，页面内三 tab
 * （战役计划 / 商机 / 触达）。14-1 先落空壳；14-2 按 M2.1、步 10、步 11 的 API 挂接。
 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:handshake',
      order: 5,
      title: navTitle('growth'),
    },
    name: 'Growth',
    path: '/growth',
    component: () => import('#/views/growth/index.vue'),
  },
];

export default routes;

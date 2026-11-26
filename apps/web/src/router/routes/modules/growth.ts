import type { RouteRecordRaw } from 'vue-router';

import { GROWTH_PAGE_HIDDEN } from '#/feature-flags';

import { navTitle } from '../nav';

/**
 * 「商机与触达」合并入口（P6 设计 D-14-a）：一个一级导航，页面内三 tab
 * （战役计划 / 商机 / 触达）。14-1 先落空壳；14-2 按 M2.1、步 10、步 11 的 API 挂接。
 *
 * 引擎侧尚未就绪，当前从菜单隐藏（见 feature-flags）；路由与深链保持可用。
 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      fullPathKey: false,
      hideInMenu: GROWTH_PAGE_HIDDEN,
      icon: 'lucide:handshake',
      order: 6,
      title: navTitle('growth'),
    },
    name: 'Growth',
    path: '/growth',
    component: () => import('#/views/growth/index.vue'),
  },
];

export default routes;

import type { RouteRecordRaw } from 'vue-router';

import { navTitle } from '../nav';

/** 成效复盘是只读总览入口，与触达写操作的开放范围独立。 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
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

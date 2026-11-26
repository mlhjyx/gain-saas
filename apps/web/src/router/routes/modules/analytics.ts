import type { RouteRecordRaw } from 'vue-router';

import { navTitle } from '../nav';

/**
 * 成效复盘与度量（Wave B2「3 组 8 项」一级入口，归属「总览」组，常驻可见）。
 * 原 /growth?tab=metrics 与 /reports 均通过 legacy.ts 重定向至此。
 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:bar-chart-3',
      order: 2,
      title: navTitle('analytics'),
    },
    name: 'Analytics',
    path: '/analytics',
    component: () => import('#/views/metrics/index.vue'),
  },
];

export default routes;

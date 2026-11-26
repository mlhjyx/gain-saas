import type { RouteRecordRaw } from 'vue-router';

import { navTitle } from '../nav';

/** 顶区高频核心项：通知（异步任务进展与待办收件箱，位于工作台下方）。 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:bell',
      order: 2,
      title: navTitle('notifications'),
    },
    name: 'Notifications',
    path: '/notifications',
    component: () => import('#/views/notifications/index.vue'),
  },
];

export default routes;

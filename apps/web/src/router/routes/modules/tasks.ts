import type { RouteRecordRaw } from 'vue-router';

import { navTitle } from '../nav';

/**
 * 寻源记录（任务与运行详情，归属「获客主线」order: 6）。
 * /runs/:runId 与 /tasks/:taskId 均高亮 /tasks。
 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:list-checks',
      order: 6,
      title: navTitle('tasks'),
    },
    name: 'Tasks',
    path: '/tasks',
    component: () => import('#/views/tasks/index.vue'),
  },
  {
    meta: {
      activePath: '/tasks',
      hideInMenu: true,
      title: 'gainos.tasks.detailTitle',
    },
    name: 'TaskDetail',
    path: '/tasks/:taskId',
    component: () => import('#/views/tasks/detail.vue'),
  },
];

export default routes;

import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

/**
 * 挖掘任务列表（Q32：任务为导航主轴）。
 * run 仍然只作为任务下的执行记录（/runs/:runId 隐藏路由），任务本身在这里可达。
 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:list-checks',
      order: 4,
      title: $t('gainos.menu.tasks'),
    },
    name: 'Tasks',
    path: '/tasks',
    component: () => import('#/views/tasks/index.vue'),
  },
];

export default routes;

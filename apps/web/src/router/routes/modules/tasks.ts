import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

import { navTitle } from '../nav';

/**
 * 挖掘任务列表（Q32：任务为导航主轴，Wave B2 归属「获客与筛选」组 order: 5）。
 * run 仍然只作为任务下的执行记录（/runs/:runId 隐藏路由），与 /tasks/:taskId 均高亮 /tasks。
 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:list-checks',
      order: 5,
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
      title: $t('gainos.tasks.detailTitle'),
    },
    name: 'TaskDetail',
    path: '/tasks/:taskId',
    component: () => import('#/views/tasks/detail.vue'),
  },
];

export default routes;

import type { RouteRecordRaw } from 'vue-router';

import { navTitle } from '../nav';

const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:layout-dashboard',
      order: 1,
      title: navTitle('workspace'),
    },
    name: 'WorkspaceHome',
    path: '/workspace',
    component: () => import('#/views/workspace/index.vue'),
  },
];

export default routes;

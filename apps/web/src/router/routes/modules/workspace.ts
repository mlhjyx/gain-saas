import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:layout-dashboard',
      order: 1,
      title: $t('gainos.menu.workspace'),
    },
    name: 'WorkspaceHome',
    path: '/workspace',
    component: () => import('#/views/workspace/index.vue'),
  },
];

export default routes;

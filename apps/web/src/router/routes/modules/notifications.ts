import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

const routes: RouteRecordRaw[] = [
  {
    meta: {
      hideInMenu: true,
      title: $t('gainos.notifications.pageTitle'),
    },
    name: 'Notifications',
    path: '/notifications',
    component: () => import('#/views/notifications/index.vue'),
  },
];

export default routes;

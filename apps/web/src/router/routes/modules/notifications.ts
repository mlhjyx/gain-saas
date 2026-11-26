import type { RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    meta: {
      hideInMenu: true,
      title: 'gainos.notifications.pageTitle',
    },
    name: 'Notifications',
    path: '/notifications',
    component: () => import('#/views/notifications/index.vue'),
  },
];

export default routes;

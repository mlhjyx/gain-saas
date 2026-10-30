import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:building-2',
      order: 2,
      title: $t('gainos.menu.companies'),
    },
    name: 'Companies',
    path: '/companies',
    component: () => import('#/views/companies/index.vue'),
  },
];

export default routes;

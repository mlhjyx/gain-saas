import type { RouteRecordRaw } from 'vue-router';

import { navTitle } from '../nav';

const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:building-2',
      order: 2,
      title: navTitle('companies'),
    },
    name: 'Companies',
    path: '/companies',
    component: () => import('#/views/companies/index.vue'),
  },
];

export default routes;

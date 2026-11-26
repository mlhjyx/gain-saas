import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

/**
 * M9-PR3 独立注册的企业自有外联发信箱与 DNS 自检设置页路由（零冲突自发现，不改 settings.ts）。
 */
const routes: RouteRecordRaw[] = [
  {
    component: () => import('#/views/settings/outreach-mailboxes.vue'),
    meta: {
      authority: ['admin'],
      hideInMenu: true,
      icon: 'lucide:mail-check',
      title: $t('outreach-byo.pageTitle'),
    },
    name: 'SettingsOutreachMailboxes',
    path: '/settings/outreach-mailboxes',
  },
];

export default routes;

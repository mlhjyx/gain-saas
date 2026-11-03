import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:settings',
      order: 6,
      title: $t('gainos.menu.settings'),
    },
    name: 'Settings',
    path: '/settings',
    redirect: '/settings/members',
    children: [
      {
        name: 'SettingsMembers',
        path: 'members',
        component: () => import('#/views/settings/members.vue'),
        meta: {
          icon: 'lucide:users-round',
          title: $t('gainos.menu.members'),
        },
      },
      {
        name: 'SettingsWorkspaces',
        path: 'workspaces',
        component: () => import('#/views/settings/workspaces.vue'),
        meta: {
          icon: 'lucide:building-2',
          title: $t('gainos.menu.workspaces'),
        },
      },
      {
        name: 'SettingsPrivacy',
        path: 'privacy',
        component: () => import('#/views/settings/privacy.vue'),
        meta: {
          authority: ['admin'],
          icon: 'lucide:shield-check',
          title: $t('gainos.menu.privacy'),
        },
      },
      {
        name: 'SettingsAudit',
        path: 'audit',
        component: () => import('#/views/settings/audit.vue'),
        meta: {
          authority: ['admin'],
          icon: 'lucide:scroll-text',
          title: $t('gainos.menu.audit'),
        },
      },
    ],
  },
];

export default routes;

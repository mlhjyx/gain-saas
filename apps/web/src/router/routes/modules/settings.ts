import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

import { navTitle } from '../nav';

const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:settings',
      order: 6,
      title: navTitle('settings'),
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
        name: 'SettingsSuppressions',
        path: 'suppressions',
        component: () => import('#/views/settings/suppressions.vue'),
        meta: {
          authority: ['admin'],
          icon: 'lucide:ban',
          title: $t('gainos.menu.suppressions'),
        },
      },
      {
        name: 'SettingsSources',
        path: 'sources',
        component: () => import('#/views/settings/sources.vue'),
        meta: {
          authority: ['admin'],
          icon: 'lucide:database',
          title: $t('gainos.menu.sources'),
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

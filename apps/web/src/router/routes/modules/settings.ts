import type { RouteRecordRaw } from 'vue-router';

import { navTitle } from '../nav';

const routes: RouteRecordRaw[] = [
  {
    meta: {
      icon: 'lucide:settings',
      order: 99,
      title: navTitle('settings'),
    },
    name: 'Settings',
    path: '/settings',
    redirect: '/settings/account',
    children: [
      {
        name: 'SettingsAccount',
        path: 'account',
        component: () => import('#/views/settings/account.vue'),
        meta: {
          icon: 'lucide:user-cog',
          title: 'gainosB3.menu.account',
        },
      },
      {
        name: 'SettingsMembers',
        path: 'members',
        component: () => import('#/views/settings/members.vue'),
        meta: {
          icon: 'lucide:users-round',
          title: 'gainos.menu.members',
        },
      },
      {
        name: 'SettingsSuppressions',
        path: 'suppressions',
        component: () => import('#/views/settings/suppressions.vue'),
        meta: {
          authority: ['admin'],
          icon: 'lucide:ban',
          title: 'gainos.menu.suppressions',
        },
      },
      {
        name: 'SettingsSources',
        path: 'sources',
        component: () => import('#/views/settings/sources.vue'),
        meta: {
          authority: ['admin'],
          icon: 'lucide:database',
          title: 'gainos.menu.sources',
        },
      },
      {
        name: 'SettingsPrivacy',
        path: 'privacy',
        component: () => import('#/views/settings/privacy.vue'),
        meta: {
          authority: ['admin'],
          icon: 'lucide:shield-check',
          title: 'gainos.menu.privacy',
        },
      },
      {
        name: 'SettingsAudit',
        path: 'audit',
        component: () => import('#/views/settings/audit.vue'),
        meta: {
          authority: ['admin'],
          icon: 'lucide:scroll-text',
          title: 'gainos.menu.audit',
        },
      },
    ],
  },
];

export default routes;

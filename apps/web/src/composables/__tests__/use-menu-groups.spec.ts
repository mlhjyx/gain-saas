import type { MenuRecordRaw } from '@vben/types';

import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { localeState, translations } = vi.hoisted(() => ({
  localeState: { current: 'zh-CN' },
  translations: {
    'en-US': {
      'gainos.menu.members': 'Members & Roles',
      'gainosB3.menu.account': 'Account & workspace',
      'gainosUi1.nav.groupOverview': 'Overview',
      'gainosUi1.nav.groupAcquisition': 'Acquisition',
      'gainosUi1.nav.groupEngagement': 'Engagement',
      'gainosUi1.nav.groupSettings': 'Settings',
    },
    'zh-CN': {
      'gainos.menu.members': '成员与角色',
      'gainosB3.menu.account': '账号与空间',
      'gainosUi1.nav.groupOverview': '总览',
      'gainosUi1.nav.groupAcquisition': '获客与筛选',
      'gainosUi1.nav.groupEngagement': '触达与转化',
      'gainosUi1.nav.groupSettings': '设置',
    },
  } as Record<string, Record<string, string>>,
}));

vi.mock('@vben/preferences', async () => {
  const { reactive } = await import('vue');
  return {
    preferences: reactive({
      app: {
        locale: 'zh-CN',
      },
    }),
  };
});

vi.mock('@vben/locales', async () => {
  const { ref } = await import('vue');
  return {
    i18n: {
      global: {
        locale: ref('zh-CN'),
      },
    },
  };
});

vi.mock('#/locales', () => ({
  $t: (key: string) => translations[localeState.current]?.[key] ?? key,
}));

import { i18n } from '@vben/locales';
import { preferences } from '@vben/preferences';
import { useAccessStore } from '@vben/stores';

import { isNavPathActive } from '#/components/gainos/use-sdr-nav';
import { groupMenus, useMenuGroups } from '#/composables/use-menu-groups';
import { navTitle } from '#/router/routes/nav';

function menu(path: string, name: string): MenuRecordRaw {
  return { name, path } as MenuRecordRaw;
}

describe('use-menu-groups（PR-UI1 新版展示目录与零刷新语言热切换）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localeState.current = 'zh-CN';
    preferences.app.locale = 'zh-CN';
    i18n.global.locale.value = 'zh-CN';
  });

  const baseMenus: MenuRecordRaw[] = [
    menu('/workspace', '工作台'),
    menu('/notifications', '通知'),
    menu('/companies', '企业档案'),
    menu('/find-buyers', '买家画像'),
    menu('/leads', '买家线索'),
    menu('/tasks', '寻源记录'),
    {
      children: [
        menu('/settings/account', 'gainosB3.menu.account'),
        menu('/settings/members', 'gainos.menu.members'),
      ],
      name: '设置',
      path: '/settings',
    } as MenuRecordRaw,
  ];

  it('触达入口关闭时，成效复盘仍在总览', () => {
    const grouped = groupMenus([...baseMenus, menu('/analytics', '成效复盘')]);
    const businessGroups = grouped.filter((item) => item.query?.__uiGroup);

    expect(businessGroups.map((group) => group.query?.__uiGroup)).toEqual([
      'core',
      'acquisition',
    ]);
    expect(businessGroups[0]?.name).toBe('总览');
    expect(businessGroups[0]?.children?.map((child) => child.path)).toEqual([
      '/workspace',
      '/analytics',
      '/notifications',
    ]);
    expect(businessGroups[1]?.name).toBe('获客与筛选');
    expect(businessGroups[1]?.children?.map((child) => child.path)).toEqual([
      '/companies',
      '/find-buyers',
      '/tasks',
      '/leads',
    ]);
    for (const group of businessGroups) {
      expect(group.children?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
    expect(grouped.find((item) => item.path === '/settings')).toBeDefined();
  });

  it('触达开放后展示外发与战役、商机管线，成效复盘继续归属总览', () => {
    const grouped = groupMenus([
      ...baseMenus,
      menu('/outreach', '外发与战役'),
      menu('/opportunities', '商机管线'),
      menu('/analytics', '成效复盘'),
    ]);
    const businessGroups = grouped.filter((item) => item.query?.__uiGroup);

    expect(businessGroups.map((group) => group.query?.__uiGroup)).toEqual([
      'core',
      'acquisition',
      'engagement',
    ]);
    expect(businessGroups[2]?.name).toBe('触达与转化');
    expect(businessGroups[2]?.children?.map((child) => child.path)).toEqual([
      '/outreach',
      '/opportunities',
    ]);
    expect(businessGroups[0]?.children?.map((child) => child.path)).toContain('/analytics');
    const totalBusinessItems = businessGroups.reduce(
      (sum, group) => sum + (group.children?.length ?? 0),
      0,
    );
    expect(totalBusinessItems).toBe(9);
    for (const group of businessGroups) {
      expect(group.children?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });

  it('isNavPathActive 优先遵从 meta.activePath，使 /runs/:runId 高亮 /tasks', () => {
    expect(isNavPathActive('/tasks', '/runs/run-1', '/tasks')).toBe(true);
    expect(isNavPathActive('/leads', '/runs/run-1', '/tasks')).toBe(false);
    expect(isNavPathActive('/tasks', '/tasks/task-1', '/tasks')).toBe(true);
    expect(isNavPathActive('/leads', '/leads/lead-1', '/leads')).toBe(true);
    expect(isNavPathActive('/outreach', '/outreach/campaigns/camp-1', '/outreach')).toBe(true);
    expect(isNavPathActive('/opportunities', '/outreach/campaigns/camp-1', '/outreach')).toBe(false);
    expect(isNavPathActive('/leads', '/leads/lead-1')).toBe(true);
  });

  it('navTitle 返回可热切换键，切语言时 useMenuGroups 突破 alreadyGrouped 实时刷新分组与子菜单名', async () => {
    expect(navTitle('workspace')).toBe('gainosNav.workspace');

    const accessStore = useAccessStore();
    accessStore.setAccessMenus([
      menu('/workspace', navTitle('workspace')),
      menu('/notifications', navTitle('notifications')),
      menu('/companies', navTitle('companies')),
      menu('/find-buyers', navTitle('findBuyers')),
      menu('/leads', navTitle('leads')),
      menu('/tasks', navTitle('tasks')),
      {
        children: [
          menu('/settings/account', 'gainosB3.menu.account'),
          menu('/settings/members', 'gainos.menu.members'),
        ],
        name: navTitle('settings'),
        path: '/settings',
      } as MenuRecordRaw,
    ]);

    useMenuGroups();
    await nextTick();

    // 初始中文态
    expect(accessStore.accessMenus.map((m) => m.name)).toEqual(['总览', '获客与筛选', '设置']);
    expect(accessStore.accessMenus[0]?.children?.map((c) => c.name)).toEqual(['工作台', '通知']);
    expect(accessStore.accessMenus[1]?.children?.map((c) => c.name)).toEqual([
      '企业档案',
      '买家画像',
      '寻源记录',
      '买家线索',
    ]);
    expect(accessStore.accessMenus[2]?.children?.map((c) => c.name)).toEqual([
      '账号与空间',
      '成员与角色',
    ]);

    // 切换为 en-US（零刷新）
    localeState.current = 'en-US';
    i18n.global.locale.value = 'en-US';
    preferences.app.locale = 'en-US';
    await nextTick();

    expect(accessStore.accessMenus.map((m) => m.name)).toEqual(['Overview', 'Acquisition', 'Settings']);
    expect(accessStore.accessMenus[0]?.children?.map((c) => c.name)).toEqual([
      'Workspace',
      'Notifications',
    ]);
    expect(accessStore.accessMenus[1]?.children?.map((c) => c.name)).toEqual([
      'Company profile',
      'Buyer profiles',
      'Sourcing history',
      'Buyer leads',
    ]);
    expect(accessStore.accessMenus[2]?.children?.map((c) => c.name)).toEqual([
      'Account & workspace',
      'Members & Roles',
    ]);

    // 切回 zh-CN（反复切换不锁死）
    localeState.current = 'zh-CN';
    i18n.global.locale.value = 'zh-CN';
    preferences.app.locale = 'zh-CN';
    await nextTick();

    expect(accessStore.accessMenus.map((m) => m.name)).toEqual(['总览', '获客与筛选', '设置']);
    expect(accessStore.accessMenus[0]?.children?.map((c) => c.name)).toEqual(['工作台', '通知']);
  });
});

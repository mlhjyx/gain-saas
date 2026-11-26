import type { MenuRecordRaw } from '@vben/types';

import { describe, expect, it, vi } from 'vitest';

vi.mock('#/locales', () => ({
  $t: (key: string) => key,
}));

import { isNavPathActive } from '#/components/gainos/use-sdr-nav';
import { groupMenus } from '#/composables/use-menu-groups';

function menu(path: string, name: string): MenuRecordRaw {
  return { name, path } as MenuRecordRaw;
}

describe('use-menu-groups（3 组 8 项信息架构）', () => {
  const baseMenus: MenuRecordRaw[] = [
    menu('/workspace', '工作台'),
    menu('/analytics', '成效复盘'),
    menu('/companies', '公司档案'),
    menu('/find-buyers', '买家画像'),
    menu('/tasks', '挖掘任务'),
    menu('/leads', '买家线索'),
    {
      children: [menu('/settings/members', '成员与角色')],
      name: '设置',
      path: '/settings',
    } as MenuRecordRaw,
  ];

  it('GROWTH_PAGE_HIDDEN=true 时隐藏触达与转化分组，且零单条目业务分组', () => {
    const grouped = groupMenus(baseMenus);
    const businessGroups = grouped.filter((item) => item.query?.__uiGroup);

    expect(businessGroups.map((group) => group.query?.__uiGroup)).toEqual([
      'overview',
      'acquisition',
    ]);
    expect(businessGroups[0]?.children?.map((child) => child.path)).toEqual([
      '/workspace',
      '/analytics',
    ]);
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

  it('GROWTH_PAGE_HIDDEN=false 时呈现全部 3 组 8 项且顺序固定', () => {
    const grouped = groupMenus([
      ...baseMenus,
      menu('/outreach', '外发与战役'),
      menu('/opportunities', '商机管线'),
    ]);
    const businessGroups = grouped.filter((item) => item.query?.__uiGroup);

    expect(businessGroups.map((group) => group.query?.__uiGroup)).toEqual([
      'overview',
      'acquisition',
      'engagement',
    ]);
    expect(businessGroups[2]?.children?.map((child) => child.path)).toEqual([
      '/outreach',
      '/opportunities',
    ]);
    const totalBusinessItems = businessGroups.reduce(
      (sum, group) => sum + (group.children?.length ?? 0),
      0,
    );
    expect(totalBusinessItems).toBe(8);
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
});

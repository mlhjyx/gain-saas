import type { MenuRecordRaw } from '@vben/types';

import { watch } from 'vue';

import { useAccessStore } from '@vben/stores';

import { $t } from '#/locales';

/**
 * 侧边栏业务分组（Wave B2「3 组 8 项」一级信息架构）。
 *
 * 路由本身保持扁平（path/name/component 一律不动），这里只在 Vben 的菜单数据层
 * 把一级菜单收进 3 个业务组 + 设置：
 * - 总览（overview）：/workspace、/analytics
 * - 获客与筛选（acquisition）：/companies、/find-buyers、/tasks、/leads
 * - 触达与转化（engagement）：/outreach、/opportunities（受 GROWTH_PAGE_HIDDEN 控制；无可见子项时整组自动隐藏）
 * - 设置（settings）：/settings
 *
 * 组节点使用第一个子项的真实 path，避免全局搜索把用户带到不存在的路径。
 * 分组是纯展示层：不新增路由、不改权限、不改菜单元数据；未匹配到的未来菜单
 * 会原样留在顶层，避免新增页面被静默吞掉。
 */
export interface MenuGroup {
  icon: string;
  key: string;
  labelKey: string;
  paths: string[];
}

export const MENU_GROUPS: MenuGroup[] = [
  {
    icon: 'lucide:layout-dashboard',
    key: 'overview',
    labelKey: 'gainos.menu.groupOverview',
    paths: ['/workspace', '/analytics'],
  },
  {
    icon: 'lucide:radar',
    key: 'acquisition',
    labelKey: 'gainos.menu.groupAcquisition',
    paths: ['/companies', '/find-buyers', '/tasks', '/leads'],
  },
  {
    icon: 'lucide:send',
    key: 'engagement',
    labelKey: 'gainos.menu.groupEngagement',
    paths: ['/outreach', '/opportunities'],
  },
  {
    icon: 'lucide:settings',
    key: 'settings',
    labelKey: 'gainos.menu.groupSettings',
    paths: ['/settings'],
  },
];

function alreadyGrouped(menus: MenuRecordRaw[]): boolean {
  return menus.some((menu) => Boolean(menu.query?.__uiGroup));
}

export function groupMenus(menus: MenuRecordRaw[]): MenuRecordRaw[] {
  const remaining = new Map(menus.map((menu) => [menu.path, menu]));
  const grouped: MenuRecordRaw[] = [];
  let order = 1;

  for (const group of MENU_GROUPS) {
    // 设置本身就是带子页的菜单节点，直接作为“设置”组使用，避免双层“设置”。
    if (group.key === 'settings') {
      const settings = remaining.get('/settings');
      if (settings) {
        grouped.push({
          ...settings,
          name: $t(group.labelKey),
          order: order++,
        });
        remaining.delete('/settings');
        continue;
      }
    }

    const children = group.paths
      .map((path) => remaining.get(path))
      .filter((menu): menu is MenuRecordRaw => Boolean(menu));
    if (children.length === 0) continue;

    // 组节点借用第一个子项的真实 path：全局搜索命中组名时也能落到有效页面。
    const groupPath = children[0]!.path;
    grouped.push({
      children: children.map((child) => ({
        ...child,
        parent: groupPath,
        parents: [...(child.parents ?? []), groupPath],
      })),
      icon: group.icon,
      name: $t(group.labelKey),
      order: order++,
      path: groupPath,
      query: { __uiGroup: group.key },
    });
    for (const child of children) remaining.delete(child.path);
  }

  // 未来新增但未登记分组的菜单：保留顶层，避免被吞。
  grouped.push(...remaining.values());
  return grouped;
}

export function useMenuGroups(): void {
  const accessStore = useAccessStore();

  watch(
    () => accessStore.accessMenus,
    (menus) => {
      if (!menus.length || alreadyGrouped(menus)) return;
      accessStore.setAccessMenus(groupMenus(menus));
    },
    { deep: false, immediate: true },
  );
}

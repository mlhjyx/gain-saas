import type { MenuRecordRaw } from '@vben/types';

import { watch } from 'vue';

import { i18n } from '@vben/locales';
import { preferences } from '@vben/preferences';
import { useAccessStore } from '@vben/stores';

import { $t } from '#/locales';
import { navKeyFromTitle, resolveNavTitle } from '#/router/routes/nav';

/**
 * 侧边栏业务分组（PR-UI1 新版极简 B2B 展示目录 + Wave B3 零刷新语言热切换）。
 *
 * 路由本身保持扁平（path/name/component 一律不动），这里只在 Vben 的菜单数据层
 * 将菜单收进新版目录结构：
 * - 总览（core）：/workspace、/analytics、/notifications
 * - 获客与筛选（acquisition）：/companies、/find-buyers、/tasks、/leads
 * - 触达与转化（engagement）：/outreach、/opportunities（无可见子项时整组自动隐藏）
 * - 设置（settings）：/settings（主侧栏过滤，由底部「设置」直达 /settings/account）
 *
 * 组节点使用第一个子项的真实 path，避免全局搜索把用户带到不存在的路径。
 * 零刷新热切换：用 WeakMap 记住原始未翻译名称（如 gainosNav.workspace / gainos.menu.members），
 * 监听 preferences.app.locale 与 i18n.global.locale 变化时重新构建分组标签与子菜单名，
 * 不被 alreadyGrouped 锁死。
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
    key: 'core',
    labelKey: 'gainosUi1.nav.groupOverview',
    paths: ['/workspace', '/analytics', '/notifications'],
  },
  {
    icon: 'lucide:radar',
    key: 'acquisition',
    labelKey: 'gainosUi1.nav.groupAcquisition',
    paths: ['/companies', '/find-buyers', '/tasks', '/leads'],
  },
  {
    icon: 'lucide:send',
    key: 'engagement',
    labelKey: 'gainosUi1.nav.groupEngagement',
    paths: ['/outreach', '/opportunities'],
  },
  {
    icon: 'lucide:settings',
    key: 'settings',
    labelKey: 'gainosUi1.nav.groupSettings',
    paths: ['/settings'],
  },
];

const rawMenuNameMap = new WeakMap<MenuRecordRaw, string>();

function getRawName(menu: MenuRecordRaw): string {
  return rawMenuNameMap.get(menu) ?? menu.name;
}

function resolveMenuLabel(rawName: string, locale: string): string {
  if (!rawName) return rawName;
  if (navKeyFromTitle(rawName)) {
    return resolveNavTitle(rawName, locale);
  }
  return $t(rawName);
}

function translateMenuTree(menu: MenuRecordRaw, locale: string): MenuRecordRaw {
  const rawName = getRawName(menu);
  const next: MenuRecordRaw = {
    ...menu,
    name: resolveMenuLabel(rawName, locale),
    ...(menu.children?.length
      ? { children: menu.children.map((child) => translateMenuTree(child, locale)) }
      : {}),
  };
  rawMenuNameMap.set(next, rawName);
  return next;
}

function alreadyGrouped(menus: MenuRecordRaw[]): boolean {
  return menus.some((menu) => Boolean(menu.query?.__uiGroup));
}

function ungroupMenus(menus: MenuRecordRaw[]): MenuRecordRaw[] {
  const flat: MenuRecordRaw[] = [];
  for (const menu of menus) {
    if (menu.query?.__uiGroup && menu.children?.length) {
      for (const child of menu.children) {
        const rawName = getRawName(child);
        const parents = child.parents?.filter((p) => p !== menu.path);
        const restored: MenuRecordRaw = {
          ...child,
          parent: undefined,
          parents: parents?.length ? parents : undefined,
        };
        rawMenuNameMap.set(restored, rawName);
        flat.push(restored);
      }
      continue;
    }
    flat.push(menu);
  }
  return flat;
}

export function groupMenus(
  menus: MenuRecordRaw[],
  locale: string = preferences.app.locale,
): MenuRecordRaw[] {
  const normalized = alreadyGrouped(menus) ? ungroupMenus(menus) : menus;
  const remaining = new Map(normalized.map((menu) => [menu.path, menu]));
  const grouped: MenuRecordRaw[] = [];
  let order = 1;

  for (const group of MENU_GROUPS) {
    // 设置本身就是带子页的菜单节点，直接作为“设置”组使用，避免双层“设置”。
    if (group.key === 'settings') {
      const settings = remaining.get('/settings');
      if (settings) {
        const translatedChildren = settings.children?.map((child) =>
          translateMenuTree(child, locale),
        );
        const nextSettings: MenuRecordRaw = {
          ...settings,
          ...(translatedChildren ? { children: translatedChildren } : {}),
          name: $t(group.labelKey),
          order: order++,
        };
        rawMenuNameMap.set(nextSettings, group.labelKey);
        grouped.push(nextSettings);
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
    const groupName = group.labelKey ? $t(group.labelKey) : '';
    const groupedNode: MenuRecordRaw = {
      children: children.map((child) => {
        const translated = translateMenuTree(child, locale);
        const rawName = getRawName(translated);
        const leaf: MenuRecordRaw = {
          ...translated,
          parent: groupPath,
          parents: [...(translated.parents ?? []), groupPath],
        };
        rawMenuNameMap.set(leaf, rawName);
        return leaf;
      }),
      icon: group.icon,
      name: groupName,
      order: order++,
      path: groupPath,
      query: { __uiGroup: group.key },
    };
    rawMenuNameMap.set(groupedNode, group.labelKey);
    grouped.push(groupedNode);
    for (const child of children) remaining.delete(child.path);
  }

  // 未来新增但未登记分组的菜单：保留顶层，避免被吞。
  for (const leftover of remaining.values()) {
    grouped.push(translateMenuTree(leftover, locale));
  }
  return grouped;
}

export function useMenuGroups(): void {
  const accessStore = useAccessStore();
  let sourceMenus: MenuRecordRaw[] = [];
  let appliedLocale: string | null = null;
  let rebuilding = false;

  const rebuild = (menus: MenuRecordRaw[], locale: string): void => {
    if (!menus.length || rebuilding) return;
    rebuilding = true;
    try {
      appliedLocale = locale;
      accessStore.setAccessMenus(groupMenus(menus, locale));
    } finally {
      rebuilding = false;
    }
  };

  watch(
    () => accessStore.accessMenus,
    (menus) => {
      if (rebuilding) return;
      if (!menus.length) {
        sourceMenus = [];
        appliedLocale = null;
        return;
      }
      const locale = preferences.app.locale;
      if (!alreadyGrouped(menus)) {
        sourceMenus = menus;
        rebuild(sourceMenus, locale);
        return;
      }
      if (appliedLocale !== locale) {
        rebuild(sourceMenus.length ? sourceMenus : menus, locale);
      }
    },
    { deep: false, immediate: true },
  );

  watch(
    [() => preferences.app.locale, () => i18n.global.locale.value],
    ([prefLocale]) => {
      const menus = sourceMenus.length ? sourceMenus : accessStore.accessMenus;
      if (!menus.length) return;
      rebuild(menus, prefLocale);
    },
  );
}

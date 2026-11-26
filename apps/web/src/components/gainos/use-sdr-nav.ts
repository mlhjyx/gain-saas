/**
 * 侧栏导航数据（2026-11-25 抽出；Wave B3 支持零刷新语言热切换）。
 *
 * 桌面覆盖层、折叠态图标窄栏、手机抽屉三处共用同一份数据：拍平 accessMenus →
 * 分组小标签 + 永远可见的菜单行（无折叠手风琴）。数据与 use-menu-groups 同源，
 * 不新增路由。
 */
import type { MenuRecordRaw } from '@vben/types';

import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { preferences } from '@vben/preferences';
import { useAccessStore } from '@vben/stores';

import { resolveNavTitle } from '#/router/routes/nav';

export interface SdrNavLeaf {
  icon?: string;
  label: string;
  path: string;
}

export interface SdrNavSection {
  items: SdrNavLeaf[];
  label: string;
}

export function isNavPathActive(
  path: string,
  currentPath: string,
  activePath?: unknown,
): boolean {
  if (typeof activePath === 'string' && activePath.length > 0) {
    return activePath === path;
  }
  if (currentPath === path) return true;
  // 详情页归属列表页：/leads/x 高亮 /leads。
  return currentPath.startsWith(`${path}/`);
}

export function useSdrNav() {
  const route = useRoute();
  const router = useRouter();
  const accessStore = useAccessStore();

  /** 拍平 accessMenus：分组 → 小标签 + 永远可见的行（无折叠手风琴）。 */
  const sections = computed<SdrNavSection[]>(() => {
    const locale = preferences.app.locale;
    const rows: SdrNavSection[] = [];
    const fallbackIcon = 'lucide:circle-dot';
    const walk = (label: string, menus: MenuRecordRaw[]) => {
      const items: SdrNavLeaf[] = [];
      for (const menu of menus) {
        if (menu.children?.length) {
          walk(resolveNavTitle(menu.name || label, locale), menu.children);
          continue;
        }
        if (!menu.path || menu.path.startsWith('__')) continue;
        // 设置由底部「设置」直达整页 /settings/account，不再占主业务导航分组。
        if (menu.path.startsWith('/settings')) continue;
        items.push({
          icon: typeof menu.icon === 'string' ? menu.icon : fallbackIcon,
          label: resolveNavTitle(menu.name, locale),
          path: menu.path,
        });
      }
      if (items.length > 0) rows.push({ items, label });
    };
    for (const menu of accessStore.accessMenus) {
      if (menu.children?.length) {
        walk(resolveNavTitle(menu.name || '', locale), menu.children);
      } else if (
        menu.path &&
        !menu.path.startsWith('__') &&
        !menu.path.startsWith('/settings')
      ) {
        walk('', [menu]);
      }
    }
    return rows;
  });

  const flatLeaves = computed<SdrNavLeaf[]>(() =>
    sections.value.flatMap((section) => section.items),
  );

  function isActive(path: string): boolean {
    return isNavPathActive(path, route.path, route.meta?.activePath);
  }

  function go(path: string): void {
    void router.push(path);
  }

  return { flatLeaves, go, isActive, route, sections };
}

/**
 * 侧栏导航数据（2026-11-25 抽出）。
 *
 * 桌面覆盖层、折叠态图标窄栏、手机抽屉三处共用同一份数据：拍平 accessMenus →
 * 分组小标签 + 永远可见的菜单行（无折叠手风琴）。数据与 use-menu-groups 同源，
 * 不新增路由。
 */
import type { MenuRecordRaw } from '@vben/types';

import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useAccessStore } from '@vben/stores';

export interface SdrNavLeaf {
  icon?: string;
  label: string;
  path: string;
}

export interface SdrNavSection {
  items: SdrNavLeaf[];
  label: string;
}

export function useSdrNav() {
  const route = useRoute();
  const router = useRouter();
  const accessStore = useAccessStore();

  /** 拍平 accessMenus：分组 → 小标签 + 永远可见的行（无折叠手风琴）。 */
  const sections = computed<SdrNavSection[]>(() => {
    const rows: SdrNavSection[] = [];
    const fallbackIcon = 'lucide:circle-dot';
    const walk = (label: string, menus: MenuRecordRaw[]) => {
      const items: SdrNavLeaf[] = [];
      for (const menu of menus) {
        if (menu.children?.length) {
          walk(menu.name || label, menu.children);
          continue;
        }
        if (!menu.path || menu.path.startsWith('__')) continue;
        // pass5：设置不再占导航分组——底部「设置」打开设置弹窗（SDR 同款）。
        if (menu.path.startsWith('/settings')) continue;
        items.push({
          icon: typeof menu.icon === 'string' ? menu.icon : fallbackIcon,
          // 存的是 i18n key（模块加载早于 i18n 初始化时）或已译文本；渲染时统一过 $t。
          label: menu.name,
          path: menu.path,
        });
      }
      if (items.length > 0) rows.push({ items, label });
    };
    for (const menu of accessStore.accessMenus) {
      if (menu.children?.length) {
        walk(menu.name || '', menu.children);
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
    const current = route.path;
    if (current === path) return true;
    // 详情页归属列表页：/leads/x 高亮 /leads。
    return current.startsWith(`${path}/`);
  }

  function go(path: string): void {
    void router.push(path);
  }

  return { flatLeaves, go, isActive, route, sections };
}

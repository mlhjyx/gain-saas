import type { NavKey } from '@gain-saas/shared';

import { navLabel } from '@gain-saas/shared';
import { preferences } from '@vben/preferences';

/**
 * 一级导航用语一律取自 @gain-saas/shared 的 NAV 词表（glossary.ts），
 * 不在 i18n JSON 里另存一份，避免两处漂移（P6 设计 §4：一处概念一个词）。
 * 与既有实现一致：标题在路由模块加载时求值一次。
 */
export function navTitle(key: NavKey): string {
  return navLabel(key, preferences.app.locale);
}

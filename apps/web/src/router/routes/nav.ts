import type { NavKey } from '@gain-saas/shared';

import { NAV, navLabel } from '@gain-saas/shared';
import { preferences } from '@vben/preferences';

export const NAV_TITLE_PREFIX = 'gainosNav.';

/**
 * 一级导航用语一律取自 @gain-saas/shared 的 NAV 词表（glossary.ts），
 * 不在 i18n JSON 里另存一份，避免两处漂移（P6 设计 §4：一处概念一个词）。
 *
 * Wave B3 零刷新热切换：返回稳定 i18n 键（gainosNav.<key>），由 locales/index.ts
 * 在 loadMessages(lang) 阶段按当前语种实时注入，避免路由模块加载时静态求值一次。
 */
export function navTitle(key: NavKey): string {
  return `${NAV_TITLE_PREFIX}${key}`;
}

export function navKeyFromTitle(value: string): NavKey | null {
  if (!value.startsWith(NAV_TITLE_PREFIX)) return null;
  const key = value.slice(NAV_TITLE_PREFIX.length);
  return key in NAV ? (key as NavKey) : null;
}

export function resolveNavTitle(
  value: string,
  locale: null | string = preferences.app.locale,
): string {
  const key = navKeyFromTitle(value);
  return key ? navLabel(key, locale) : value;
}

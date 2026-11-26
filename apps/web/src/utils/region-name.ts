import { preferences } from '@vben/preferences';

let cache: { locale: string; names: Intl.DisplayNames } | null = null;

function displayNames(locale: string): Intl.DisplayNames | null {
  if (cache?.locale === locale) return cache.names;
  try {
    cache = { locale, names: new Intl.DisplayNames([locale], { type: 'region' }) };
    return cache.names;
  } catch {
    // 浏览器不支持或地区数据不可用：调用方拿到的会是原样的代码。
    return null;
  }
}

/**
 * 两位国家码 → 地区名，按界面语言显示（US → 美国 / United States）。
 * 不是合法代码、或浏览器查不到时原样返回，不会出现 undefined。
 */
export function regionName(code: string): string {
  const trimmed = code.trim();
  if (!/^[A-Za-z]{2}$/.test(trimmed)) return code;
  const locale = preferences.app.locale === 'en-US' ? 'en' : 'zh';
  const name = displayNames(locale)?.of(trimmed.toUpperCase());
  return name && name !== trimmed.toUpperCase() ? name : code;
}

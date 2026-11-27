import { preferences } from '@vben/preferences';

let cache: { locale: string; names: Intl.DisplayNames } | null = null;
let aliasToIso2Cache: Map<string, string> | null = null;

/** 常见缩写、历史别名与本地语拼写 → ISO 3166-1 alpha-2。 */
const COMMON_COUNTRY_ALIASES: Record<string, string> = {
  belgie: 'BE',
  'belgië': 'BE',
  belgique: 'BE',
  brasil: 'BR',
  'czech republic': 'CZ',
  deutschland: 'DE',
  espana: 'ES',
  'españa': 'ES',
  'great britain': 'GB',
  holland: 'NL',
  italia: 'IT',
  korea: 'KR',
  nederland: 'NL',
  oesterreich: 'AT',
  'österreich': 'AT',
  polska: 'PL',
  russia: 'RU',
  schweiz: 'CH',
  'south korea': 'KR',
  suisse: 'CH',
  svizzera: 'CH',
  turkey: 'TR',
  turkiye: 'TR',
  'türkiye': 'TR',
  uae: 'AE',
  uk: 'GB',
  'united arab emirates': 'AE',
  'united kingdom': 'GB',
  'united states': 'US',
  'united states of america': 'US',
  usa: 'US',
  'viet nam': 'VN',
  vietnam: 'VN',
  澳洲: 'AU',
  印尼: 'ID',
  沙特: 'SA',
  阿联酋: 'AE',
};

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

function aliasToIso2Map(): Map<string, string> {
  if (aliasToIso2Cache) return aliasToIso2Cache;
  const map = new Map<string, string>();
  for (const [alias, iso] of Object.entries(COMMON_COUNTRY_ALIASES)) {
    map.set(alias.normalize('NFC').toLowerCase(), iso);
  }
  try {
    const enNames = new Intl.DisplayNames(['en'], { fallback: 'none', type: 'region' });
    const zhNames = new Intl.DisplayNames(['zh'], { fallback: 'none', type: 'region' });
    for (let a = 65; a <= 90; a += 1) {
      for (let b = 65; b <= 90; b += 1) {
        const code = String.fromCharCode(a, b);
        if (code === 'EU' || code === 'UN' || code === 'QO' || code === 'ZZ' || code.startsWith('X')) {
          continue;
        }
        const en = enNames.of(code);
        if (en && en !== code) map.set(en.normalize('NFC').toLowerCase(), code);
        const zh = zhNames.of(code);
        if (zh && zh !== code) map.set(zh.normalize('NFC').toLowerCase(), code);
      }
    }
  } catch {
    // 浏览器不支持 Intl.DisplayNames fallback:'none' 时，仍保留内置别名表。
  }
  aliasToIso2Cache = map;
  return map;
}

function resolveIso2(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    const upper = trimmed.toUpperCase();
    return upper === 'UK' ? 'GB' : upper;
  }
  return aliasToIso2Map().get(trimmed.normalize('NFC').toLowerCase()) ?? null;
}

/**
 * 国家码或常见英文/中文国家全称 → 按界面语言显示的地区名（DE / Germany → 德国 / Germany）。
 * 这样历史寻源方案里混有 "Germany" 与 "DE" 时也能统一成同一语言并正确去重；
 * 不是合法国家词、或浏览器查不到时原样返回，不会出现 undefined。
 */
export function regionName(code: string): string {
  const iso2 = resolveIso2(code);
  if (!iso2) return code;
  const locale = preferences.app.locale === 'en-US' ? 'en' : 'zh';
  const name = displayNames(locale)?.of(iso2);
  return name && name !== iso2 ? name : code;
}

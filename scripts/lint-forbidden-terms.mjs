#!/usr/bin/env node
/**
 * 零术语红线机检（P6 设计 §4；计划 v1.5 §3.9）。
 *
 * 用户可见面不得出现引擎术语与裸枚举：run / ICP / canonical / plan_hash / 裸 UUID /
 * PARTIAL·FAILED·RISKY。技术详情折叠区与运营台（ops）豁免，但豁免必须写明理由。
 *
 * 扫描范围：
 *   - apps/web/src/{views,components,layouts}/**\/*.vue 的 <template> 静态文本与静态可见属性；
 *     （表达式、指令绑定、脚本是代码不是文案，不扫；运行时漏出的枚举由 Playwright 文本扫描兜底）
 *   - apps/web/src/locales/langs/**\/*.json 的全部字符串值。
 *
 * 豁免语法（必须带理由）：
 *   文件级：<!-- terms-lint-disable-file: 理由 -->（整份 .vue 跳过）
 *   区域级：<!-- terms-lint-disable: 理由 --> … <!-- terms-lint-enable -->
 *
 * 用法：node scripts/lint-forbidden-terms.mjs [repoRoot]
 * 退出码：0 = 通过；1 = 命中或豁免缺理由。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 禁用词表：id → 正则 + 替代建议（与 packages/shared/src/glossary.ts 口径一致）。 */
export const BANNED_PATTERNS = [
  { id: 'run', re: /\bruns?\b|\brun[_A-Z]\w*/i, hint: 'run → 「挖掘任务」/「本轮」' },
  { id: 'icp', re: /\bICPs?\b|\bicp[_A-Z]\w*/i, hint: 'ICP → 「目标客户画像」' },
  { id: 'canonical', re: /\bcanonical\w*/i, hint: 'canonical → 用业务语言重写' },
  { id: 'plan_hash', re: /plan[_-]?hash/i, hint: 'plan_hash → 「计划版本」' },
  {
    id: 'uuid',
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    hint: '裸 UUID → 显示名称；编号收进「技术详情」',
  },
  {
    id: 'enum',
    re: /\b(PARTIAL|FAILED|RISKY)\b/,
    hint: '裸枚举 → 状态词表（部分完成 / 未完成 / 待确认）',
  },
];

/** 用户可见的静态属性（表达式绑定 `:x="…"` 不在内）。 */
const VISIBLE_ATTRS = 'title|placeholder|label|alt|aria-label|content|value';

const FILE_EXEMPT_RE = /<!--\s*terms-lint-disable-file(?::([^>]*?))?\s*-->/;
const REGION_RE = /<!--\s*terms-lint-(disable|enable)(?::([^>]*?))?\s*-->/g;

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/** 用等长空格抹掉一个区间，保证后续 match.index 与原文件对齐。 */
function blankRange(chars, start, end) {
  for (let i = start; i < end; i += 1) {
    if (chars[i] !== '\n') chars[i] = ' ';
  }
}

/** 抽取 <template> 内容（含起止偏移）。找不到返回 null。 */
export function extractTemplate(source) {
  const open = source.indexOf('<template>');
  const close = source.lastIndexOf('</template>');
  if (open === -1 || close === -1 || close <= open) return null;
  const start = open + '<template>'.length;
  return { content: source.slice(start, close), offset: start };
}

/**
 * 扫描一份 .vue 源码，返回违规列表。
 * 返回 { violations, exempt, missingReason }：
 *   violations: [{ pattern, hint, line, snippet }]
 *   exempt: 文件级豁免理由（或 null）
 *   missingReason: 出现了豁免标记但没写理由（违规）。
 */
export function lintVueSource(source) {
  const fileMatch = FILE_EXEMPT_RE.exec(source);
  if (fileMatch) {
    const reason = (fileMatch[1] ?? '').trim();
    if (!reason) {
      return {
        exempt: null,
        missingReason: '<!-- terms-lint-disable-file --> 缺少理由',
        violations: [],
      };
    }
    return { exempt: reason, missingReason: null, violations: [] };
  }

  const template = extractTemplate(source);
  if (!template) return { exempt: null, missingReason: null, violations: [] };

  const chars = template.content.split('');
  const violations = [];
  const regionReasons = [];

  // 1) 区域级豁免：先记录区间（含理由校验），再抹掉。
  REGION_RE.lastIndex = 0;
  let openRegion = null;
  for (let m = REGION_RE.exec(template.content); m; m = REGION_RE.exec(template.content)) {
    const [raw, kind, reasonRaw] = m;
    if (kind === 'disable') {
      const reason = (reasonRaw ?? '').trim();
      if (!reason) {
        violations.push({
          pattern: 'exempt',
          hint: 'terms-lint-disable 缺少理由',
          line: lineOf(source, template.offset + m.index),
          snippet: raw.trim(),
        });
      }
      openRegion = { start: m.index + raw.length };
    } else if (openRegion) {
      blankRange(chars, openRegion.start, m.index);
      blankRange(chars, m.index, m.index + raw.length);
      openRegion = null;
    }
  }
  if (openRegion) blankRange(chars, openRegion.start, chars.length);

  // 2) 注释与插值表达式不是文案：抹掉。注意插值里的字符串字面量由 Playwright 文本扫描兜底。
  blankAll(chars, /<!--[\s\S]*?-->/g);
  blankAll(chars, /\{\{[\s\S]*?\}\}/g);

  const text = chars.join('');

  // 3) 静态文本节点。
  const textRe = />([^<>]+)</g;
  for (let m = textRe.exec(text); m; m = textRe.exec(text)) {
    checkSnippet(m[1], template.offset + m.index + 1, source, violations);
  }

  // 4) 静态可见属性。
  const attrRe = new RegExp(`\\s(?:${VISIBLE_ATTRS})="([^"]*)"`, 'g');
  for (let m = attrRe.exec(text); m; m = attrRe.exec(text)) {
    checkSnippet(m[1], template.offset + m.index, source, violations);
  }

  return { exempt: null, missingReason: null, violations };
}

function blankAll(chars, re) {
  const text = chars.join('');
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    blankRange(chars, m.index, m.index + m[0].length);
  }
}

function checkSnippet(snippet, index, source, violations) {
  for (const pattern of BANNED_PATTERNS) {
    const hit = snippet.match(pattern.re);
    if (hit) {
      violations.push({
        pattern: pattern.id,
        hint: pattern.hint,
        line: lineOf(source, index),
        snippet: snippet.trim().replace(/\s+/g, ' ').slice(0, 120),
      });
    }
  }
}

/** 扫描一份 i18n JSON（只扫字符串值，不扫键名）。 */
export function lintLocaleObject(root, file) {
  const violations = [];
  const walk = (node, path) => {
    if (typeof node === 'string') {
      for (const pattern of BANNED_PATTERNS) {
        if (pattern.re.test(node)) {
          violations.push({
            pattern: pattern.id,
            hint: pattern.hint,
            key: path.join('.'),
            snippet: node.slice(0, 120),
          });
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, [...path, String(i)]));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, [...path, key]);
    }
  };
  walk(root, []);
  return violations;
}

function walkFiles(dir, filter, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

/** 主入口：扫描仓库，返回问题列表与统计。 */
export function lintRepository(repoRoot) {
  const webSrc = join(repoRoot, 'apps/web/src');
  const vueFiles = ['views', 'components', 'layouts']
    .flatMap((dir) => walkFiles(join(webSrc, dir), (f) => f.endsWith('.vue')))
    .sort();
  const jsonFiles = walkFiles(join(webSrc, 'locales/langs'), (f) => f.endsWith('.json')).sort();

  const problems = [];
  const exemptions = [];
  let vueChecked = 0;
  let jsonChecked = 0;

  for (const file of vueFiles) {
    const rel = relative(repoRoot, file);
    const result = lintVueSource(readFileSync(file, 'utf8'));
    vueChecked += 1;
    if (result.exempt) exemptions.push(`${rel}（${result.exempt}）`);
    if (result.missingReason) problems.push(`${rel}: ${result.missingReason}`);
    for (const v of result.violations) {
      problems.push(`${rel}:${v.line} [${v.pattern}] ${v.snippet} —— ${v.hint}`);
    }
  }

  for (const file of jsonFiles) {
    const rel = relative(repoRoot, file);
    const violations = lintLocaleObject(JSON.parse(readFileSync(file, 'utf8')), file);
    jsonChecked += 1;
    for (const v of violations) {
      problems.push(`${rel} ${v.key} [${v.pattern}] ${v.snippet} —— ${v.hint}`);
    }
  }

  return { exemptions, jsonChecked, problems, vueChecked };
}

function main() {
  const repoRoot = resolve(process.argv[2] ?? join(fileURLToPath(import.meta.url), '../..'));
  const { exemptions, jsonChecked, problems, vueChecked } = lintRepository(repoRoot);

  for (const item of exemptions) console.log(`· 豁免：${item}`);

  if (problems.length > 0) {
    console.error(`\n零术语检查失败：${problems.length} 处禁用词/裸枚举（用户可见面红线，P6 设计 §4）\n`);
    for (const problem of problems) console.error(`✗ ${problem}`);
    console.error('\n修复：按 packages/shared/src/glossary.ts 词表改写文案；确属技术详情/运营台的，加豁免注释并写明理由。');
    process.exit(1);
  }

  console.log(
    `✓ 零术语检查通过：${vueChecked} 个页面模板、${jsonChecked} 个 i18n 文件的可见文案未发现禁用词（run/ICP/canonical/plan_hash/裸 UUID/裸枚举）。`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

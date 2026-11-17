/**
 * 官网合作意向表单的输入清洗（XSS 校验第一道闸）。
 *
 * 原则：
 * 1. 归一化（NFKC）、去掉零宽/控制字符，避免用不可见字符绕过黑名单；
 * 2. 显式拒绝 HTML 标签、脚本协议、事件处理器与编码后的尖括号，
 *    —— 不做「先存后转义」：运营台与其它消费方按纯文本处理，存储层保持干净；
 * 3. 长度按 Unicode 码点计，避免 emoji / 中文被 UTF-16 长度误判。
 */

export class ContentRejectedError extends Error {
  constructor(
    readonly field: string,
    readonly reason: 'REQUIRED' | 'INVALID_TYPE' | 'TOO_LONG' | 'UNSAFE',
  ) {
    super(`${field}:${reason}`);
    this.name = 'ContentRejectedError';
  }
}

/** 控制字符（保留 \n、\t）与零宽/双向控制字符。 */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠﻿]/g;

/** 危险片段：HTML 标签、脚本协议、事件处理器、编码后的尖括号。 */
const UNSAFE_PATTERNS: RegExp[] = [
  /<\s*\/?\s*[a-zA-Z!/]/,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:\s*(?:text\/html|image\/svg)/i,
  // 事件处理器：只认属性边界（空白/引号/>/;），避免把 ?online=true 这类
  // 合法 URL 查询串误判；真正的注入必然带 <tag 前缀，会被上面的标签规则拦住。
  /(?:^|[\s"'>;])on[a-z]{3,}\s*=/i,
  /&lt;|&gt;/i,
  /&#(?:x0*(?:3c|3e|22|27)|0*(?:60|62|34|39));/i,
];

const NAMED_ENTITIES: Record<string, string> = {
  colon: ':',
  tab: '\t',
  newline: '\n',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function codePointValue(code: number): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/** 解码常见 HTML 实体（含无分号数字实体），用于对抗编码绕过；仅用于判定，不用于存储。 */
function decodeEntitiesOnce(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => codePointValue(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => codePointValue(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

export interface CleanTextOptions {
  max: number;
  required?: boolean;
  /** 允许换行（多行文本）。单行字段把换行折叠为空格。 */
  multiline?: boolean;
}

/** 清洗单个文本字段；空串在 required 时抛 REQUIRED，否则返回 null。 */
export function cleanText(field: string, raw: unknown, options: CleanTextOptions): string | null {
  if (raw === undefined || raw === null) {
    if (options.required) throw new ContentRejectedError(field, 'REQUIRED');
    return null;
  }
  if (typeof raw !== 'string') throw new ContentRejectedError(field, 'INVALID_TYPE');

  // 存储用 NFC：保留中文全角标点（NFKC 会把「，」「：」折成半角，破坏原文）。
  let value = raw.normalize('NFC').replace(INVISIBLE, '');
  value = options.multiline
    ? value.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ')
    : value.replace(/\s+/g, ' ');
  value = value.trim();

  if (value.length === 0) {
    if (options.required) throw new ContentRejectedError(field, 'REQUIRED');
    return null;
  }
  if (Array.from(value).length > options.max) throw new ContentRejectedError(field, 'TOO_LONG');

  // 判定在 NFKC + 实体解码 + 去空白三份视图上做：
  // - NFKC 拦全角/兼容字符（「＜script＞」）；
  // - 实体解码拦 &colon; / &#58; / 无分号数字实体；
  // - 去空白拦 `java\nscript:` 这类用换行拆分协议名的写法。
  const nfkc = value.normalize('NFKC');
  const decoded = decodeEntitiesOnce(decodeEntitiesOnce(nfkc));
  const candidates = [nfkc, decoded, decoded.replace(/\s+/g, '')];
  for (const candidate of candidates) {
    for (const pattern of UNSAFE_PATTERNS) {
      if (pattern.test(candidate)) throw new ContentRejectedError(field, 'UNSAFE');
    }
  }
  return value;
}

// 保守字符集：故意不接受 ? & % 引号等可在 mailto: 链接里拼接参数/头部的内容
//（运营台把邮箱渲染成 mailto: 链接）。+ . _ - 足够覆盖常见地址。
const EMAIL_RE = /^[a-z0-9._+-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** 邮箱：小写、去空白、格式与长度校验（同时复用文本清洗）。 */
export function cleanEmail(raw: unknown): string {
  const value = cleanText('email', raw, { max: 254, required: true });
  if (!value) throw new ContentRejectedError('email', 'REQUIRED');
  const email = value.toLowerCase();
  // 少数码点小写化后会变长（如 U+0130 → i + U+0307），必须按转换后的长度校验，
  // 否则会撞上 VARCHAR(254) 变成 500。
  if (Array.from(email).length > 254) throw new ContentRejectedError('email', 'TOO_LONG');
  if (!EMAIL_RE.test(email)) throw new ContentRejectedError('email', 'INVALID_TYPE');
  return email;
}

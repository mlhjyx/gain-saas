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
  /\bon[a-z]{3,}\s*=/i,
  /expression\s*\(/i,
  /&lt;|&gt;/i,
  /&#(?:x0*(?:3c|3e|22|27)|0*(?:60|62|34|39));/i,
];

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

  // 危险片段在 NFKC 上判定：全角/兼容字符（如「＜script＞」）无法绕过标签规则。
  const checkValue = value.normalize('NFKC');
  for (const pattern of UNSAFE_PATTERNS) {
    if (pattern.test(checkValue)) throw new ContentRejectedError(field, 'UNSAFE');
  }
  return value;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 邮箱：小写、去空白、格式与长度校验（同时复用文本清洗）。 */
export function cleanEmail(raw: unknown): string {
  const value = cleanText('email', raw, { max: 254, required: true });
  if (!value) throw new ContentRejectedError('email', 'REQUIRED');
  const email = value.toLowerCase();
  if (!EMAIL_RE.test(email)) throw new ContentRejectedError('email', 'INVALID_TYPE');
  return email;
}

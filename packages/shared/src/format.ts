/**
 * 日期/时间显示的唯一口径（v3.0 ch07 QW14）。
 *
 * 租户界面此前 14 个视图各写各的 `toLocaleString()`：同一时刻在不同时区、
 * 不同浏览器 locale 下显示成完全不同的字符串，审计与截图无法对照。
 * 这里固定为「YYYY-MM-DD」「YYYY-MM-DD HH:mm」两种形状（本地时区），
 * 视图只能用 DateText 组件或本文件的函数；`scripts/lint-date-format.mjs`
 * 会在 CI 里禁止 views 直接调用 toLocale*。
 */

export type DateInput = Date | null | number | string | undefined;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 日期：2026-11-09。无效输入返回空串（调用方自行决定占位符）。 */
export function formatDate(value: DateInput): string {
  const date = toDate(value);
  if (!date) return '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 日期时间：2026-11-09 17:05（本地时区，24 小时制）。 */
export function formatDateTime(value: DateInput): string {
  const date = toDate(value);
  if (!date) return '';
  return `${formatDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 日期时间到秒：2026-11-09 17:05:42（审计/轨迹这类需要精确时刻的场合）。 */
export function formatDateTimeSeconds(value: DateInput): string {
  const date = toDate(value);
  if (!date) return '';
  return `${formatDateTime(date)}:${pad2(date.getSeconds())}`;
}

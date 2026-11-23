/**
 * 判定维度的界面文案（2026-11-23）。
 *
 * 维度名优先取 leads.criteria（业务短名），回退到复核页的完整判据名；
 * 判据状态走 @gain-saas/shared 词表（符合 / 偏弱 / 不符 / 证据不足 / 不适用）。
 * 模型理由里偶尔夹带 ICP 这类内部缩写，展示前统一换成人话。
 */
import { glossaryStatus } from '@gain-saas/shared';
import { preferences } from '@vben/preferences';

import { $t } from '#/locales';

import { normalizeFitVerdict, type JudgeDim } from './judge';

export type GsTone = 'danger' | 'info' | 'neutral' | 'success' | 'warning';

export function dimName(id: string): string {
  const leadsKey = `gainos.leads.criteria.${id}`;
  const short = $t(leadsKey);
  if (short !== leadsKey) return short;
  const reviewsKey = `gainos.reviews.criteria.${id}`;
  const full = $t(reviewsKey);
  return full === reviewsKey ? $t('gainos.reviews.criteriaOther') : full;
}

export function dimStatus(dim: JudgeDim): { label: string; tone: GsTone } {
  const entry = glossaryStatus('criterionLabel', dim.label, preferences.app.locale);
  if (!entry) return { label: $t('gainos.common.unknownStatus'), tone: 'neutral' };
  const tone: GsTone = entry.tone === 'processing' ? 'info' : entry.tone;
  return { label: entry.label, tone };
}

export function humanizeRationale(text: string): string {
  const label = $t('gainos.leads.icpFilter');
  // 模型理由里「ICP」前后的搭配各不相同，先处理需要补/换介词的常见组合，
  // 再兜底成业务名——只做展示替换，引擎原文仍在「技术详情」里保留。
  return text
    .replaceAll(/\bICP\s*员工范围/g, `${label}的员工范围`)
    .replaceAll(/与\s*\bICP\b\s*/g, `与${label}的`)
    .replaceAll(/\bICP\s*对/g, `${label}对`)
    .replaceAll(/\bICP\b/g, label);
}

/** 引擎结论（FIT / NOT_FIT / UNKNOWN / match…）→ 界面词表。 */
export function fitVerdictLabel(value?: null | string): string {
  return $t(`gainos.leads.fit.${normalizeFitVerdict(value)}`);
}

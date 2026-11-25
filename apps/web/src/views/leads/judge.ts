/**
 * 判定聚合文本解析（2026-11-23）。
 *
 * 引擎把五维评分写成一段用户可读的聚合文本（judge-aggregate/v1）：
 *   「聚合 judge-aggregate/v1：verdict=UNKNOWN，加权分=…，reasonCodes=…
 *     C1_MATERIAL pass（score 8）：…」
 * 这段文本直接上屏会把判据编号、机器结论码暴露给普通用户。这里把它拆成
 * 结构化维度，页面只渲染业务语言；原始文本与机器码收进「技术详情」。
 *
 * 解析是容错的：C1–C5 行可能前后有空格、半角/全角括号、中文/英文冒号，
 * 分数可能缺省为「—」。任何一行解析不出来都不影响其它维度。
 */

export type JudgeLabel = 'fail' | 'not_applicable' | 'pass' | 'unclear' | 'weak';

export interface JudgeDim {
  id: string;
  label: JudgeLabel | string;
  rationale: string;
  score: number | null;
}

export interface JudgeSummary {
  dims: JudgeDim[];
  /** 机器结论码（EVIDENCE_GATE_UNKNOWN 等），只进技术详情。 */
  reasonCodes: string[];
  raw: string;
  /** 机器裁决：UNKNOWN / FIT / NOT_FIT（原始值，仅技术详情）。 */
  verdict: string | null;
  /** 加权分说明（例如「证据门/硬门先决」），仅技术详情。 */
  weightedNote: string | null;
}

const EMPTY: JudgeSummary = {
  dims: [],
  reasonCodes: [],
  raw: '',
  verdict: null,
  weightedNote: null,
};

/** 五维的固定展示顺序（C1→C5）。 */
export const JUDGE_DIM_ORDER = [
  'C1_MATERIAL',
  'C2_ROLE',
  'C3_PROCESS',
  'C4_BUSINESS_MODEL',
  'C5_SIZE',
] as const;

/** 判断原因优先引用「角色 / 经营模式」这类决定买卖关系的维度。 */
const KEY_DIM_ORDER = [
  'C2_ROLE',
  'C4_BUSINESS_MODEL',
  'C1_MATERIAL',
  'C3_PROCESS',
  'C5_SIZE',
];

const DIM_RE =
  /\b(C[1-5]_[A-Z_]+)\b[\s:：]*\b(pass|weak|fail|unclear|not[_ ]applicable)\b(?:\s*[（(]\s*(?:score|评分)\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?|—|–|－|-|null|n\/a)\s*[)）])?/gi;

/** fit.reasons 可能是字符串、字符串数组，或引擎早期对象的若干字段。 */
export function judgeText(raw: unknown): string {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    // 早期 BFF 会把 jsonb 数组整体序列化成一个字符串，先解一层。
    if (
      (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
      (trimmed.startsWith('{') && trimmed.endsWith('}'))
    ) {
      try {
        return judgeText(JSON.parse(trimmed));
      } catch {
        /* 不是合法 JSON：按普通文本处理 */
      }
    }
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          for (const field of ['rationale', 'reason', 'text', 'summary']) {
            if (typeof record[field] === 'string') return record[field];
          }
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    for (const field of ['reasons', 'notes']) {
      if (Array.isArray(record[field])) return judgeText(record[field]);
    }
    for (const field of ['summary', 'reason', 'text']) {
      if (typeof record[field] === 'string') return record[field];
    }
  }
  return '';
}

function scoreOf(raw: string | undefined): number | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (!/^[0-9.]+$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function codeList(raw: string): string[] {
  return raw
    .replaceAll(/[[\]"']/g, ' ')
    .split(/[,，;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 解析聚合文本。识别不出任何 C1–C5 行时返回空 dims，调用方应退回
 * 「机器结论 + 业务语言理由」的降级展示，不得把原文直接上屏。
 */
export function parseJudge(raw: unknown): JudgeSummary {
  const text = judgeText(raw).trim();
  if (!text) return { ...EMPTY };

  const matches = [...text.matchAll(DIM_RE)];
  const header = matches.length > 0 ? text.slice(0, matches[0]!.index) : text;
  const verdict = /verdict\s*=\s*([A-Z_]+)/i.exec(header)?.[1] ?? null;
  const reasonCodes = codeList(
    /reasonCodes?\s*=\s*([A-Za-z0-9_,，\s[\]"']+)/.exec(header)?.[1] ?? '',
  );
  const weightedNote =
    /加权分\s*=\s*([^，,；;\n]+)/.exec(header)?.[1]?.trim() ?? null;

  const dims: JudgeDim[] = matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    const rationale = text
      .slice(start, end)
      .replace(/^[\s:：]+/, '')
      .trim();
    return {
      id: match[1]!.toUpperCase(),
      label: match[2]!.toLowerCase().replace(/\s+/g, '_'),
      rationale,
      score: scoreOf(match[3]),
    };
  });

  return {
    dims,
    raw: text,
    reasonCodes,
    verdict: verdict ? verdict.toUpperCase() : null,
    weightedNote,
  };
}

/** 引擎裁决归一成界面词表（match / weak / mismatch / unknown）。 */
export function normalizeFitVerdict(
  value: null | string | undefined,
): 'match' | 'mismatch' | 'unknown' | 'weak' {
  const normalized = (value ?? '').toUpperCase();
  if (normalized === 'FIT' || normalized === 'MATCH') return 'match';
  if (normalized === 'NOT_FIT' || normalized === 'MISMATCH') return 'mismatch';
  if (normalized === 'WEAK') return 'weak';
  return 'unknown';
}

export interface JudgeCounts {
  fail: number;
  pass: number;
  unclear: number;
  weak: number;
}

export function judgeCounts(dims: JudgeDim[]): JudgeCounts {
  const counts: JudgeCounts = { fail: 0, pass: 0, unclear: 0, weak: 0 };
  for (const dim of dims) {
    if (dim.label in counts) counts[dim.label as keyof JudgeCounts] += 1;
  }
  return counts;
}

/**
 * 列表卡片引用哪一条理由：优先「不符」的决定性维度，其次偏弱、证据不足，
 * 最后才是符合项；同档按 C2→C4→C1→C3→C5 的业务重要性排序。
 */
export function keyDimension(dims: JudgeDim[]): JudgeDim | null {
  for (const label of ['fail', 'weak', 'unclear', 'pass'] as const) {
    const hit = KEY_DIM_ORDER.map((id) => dims.find((dim) => dim.id === id)).find(
      (dim) => dim?.label === label,
    );
    if (hit) return hit;
  }
  return dims[0] ?? null;
}

/** 把长理由压到一行可读长度，尽量在句末断开（全量文本仍在展开区）。 */
export function shortRationale(text: string, max = 96): string {
  const normalized = text.replaceAll(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  const head = normalized.slice(0, max);
  const stop = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('；'),
    head.lastIndexOf('，'),
    head.lastIndexOf('. '),
  );
  const cut = stop >= max * 0.5 ? head.slice(0, stop) : head;
  return `${cut.replace(/[，,；;。.\s]+$/, '')}…`;
}

/** 原生文本里是否还夹着机器码（用于「技术详情」入口的展示判断）。 */
export function hasMachineDetail(summary: JudgeSummary): boolean {
  return Boolean(summary.verdict || summary.reasonCodes.length > 0 || summary.raw);
}

export type ScoreGrade = 'high' | 'low' | 'medium' | 'none';

/** 线索总分（0–100）分档：80+ 高价值，60+ 潜力客户，其余待观察。 */
export function scoreGrade(score?: null | number): ScoreGrade {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'none';
  if (score >= 80) return 'high';
  if (score >= 60) return 'medium';
  return 'low';
}

/** 判断这段文本是不是机器聚合原文（含判据编号/结论码/加权说明）。 */
export function isMachineAggregate(text: string): boolean {
  return /judge-aggregate|\bC[1-5]_[A-Z_]+\b|reasonCodes?\s*=|verdict\s*=/i.test(text);
}

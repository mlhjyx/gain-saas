/**
 * 找买家列表里一张画像卡的输入（2026-11-25）。
 *
 * 页面负责取数与归一，卡片只负责排版：画像 / 目标市场 / 寻源方案 / 最近寻源 / 操作。
 * 「寻源方案」「最近寻源」是进入页面时并行预取的摘要——取不到就照实显示占位，
 * 不把「加载失败」显示成「还没有」。
 */
import type { Icp } from '#/api/gainos';

export type FbTone = 'danger' | 'info' | 'neutral' | 'success' | 'warning';

/** ok=有数据；none=确实没有；loading=还在取；failed=没取到。 */
export type SummaryState = 'failed' | 'loading' | 'none' | 'ok';

export interface PlanSummary {
  label: string;
  queries: number;
  tone: FbTone;
}

export interface RunSummary {
  label: string;
  startedAt: string;
  tone: FbTone;
}

export interface IcpCardRow {
  company: string;
  id: string;
  /** 目标客户画像本身（打开详情时用）。 */
  icp: Icp;
  markets: string[];
  name: string;
  personas: number;
  plan: null | PlanSummary;
  planState: SummaryState;
  rules: number;
  run: null | RunSummary;
  runState: SummaryState;
  statusLabel: string;
  statusTone: FbTone;
  version: number;
}

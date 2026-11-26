import type { QueryPlan, TaskRunView } from '#/api/gainos';

/** 一个画像下已有的寻源方案与任务运行（找买家、买家线索页都会预取）。 */
export interface AcquisitionProgress {
  /** undefined = 这次没取到；[] = 确实还没有方案。 */
  plans?: QueryPlan[];
  runs?: TaskRunView[];
}

const byNewestPlan = (a: QueryPlan, b: QueryPlan) =>
  Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '');
const byLatestRun = (a: TaskRunView, b: TaskRunView) =>
  Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? '');

/**
 * 主链路步骤条当前在第几步（从 1 起）：
 * 完善档案 → 设定买家画像 → 确认寻源方案 → 等待寻源 → 判断线索。
 *
 * 只在画像已生效时调用；画像还没生效时由页面自己回到第 2 步。
 * - 最新方案还没确认：第 3 步（确认寻源方案）；
 * - 方案已确认、这一轮寻源还没产出（进行中、失败、取消）：第 4 步（等待寻源）；
 * - 这一轮寻源已产出线索（完成或部分完成）：第 5 步（判断线索）。
 *
 * 方案取不到时不下结论，按「等待寻源」显示，不把用户误引导去确认一份可能并不存在的方案。
 */
export function acquisitionStep(progress: AcquisitionProgress | undefined): number {
  if (progress?.plans === undefined) return 4;
  const plan = [...progress.plans].sort(byNewestPlan)[0];
  if (!plan || plan.status === 'DRAFT') return 3;
  // 只看属于这份方案的运行；旧记录没带方案归属的，仍计入。
  const runs = (progress.runs ?? []).filter(
    (run) => !run.planId || run.planId === plan.id,
  );
  const run = runs.sort(byLatestRun)[0];
  if (run && (run.status === 'DONE' || run.status === 'PARTIAL')) return 5;
  return 4;
}

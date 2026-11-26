/**
 * 主链路进度：完善档案 → 设定买家画像 → 确认寻源方案 → 等待寻源 → 判断线索。
 *
 * 底部的进度浮窗用这一份数据。进度是跨页面的，所以不放在某个页面里；只在主流程页面取
 * （公司档案、买家画像、挖掘任务、运行页、买家线索），离开就停。
 *
 * 刷新时机：页面切换到主流程页面、每 30 秒、以及关键操作之后。关键操作（激活画像、确认方案、发起寻源、
 * 判断线索……）通过 `window` 上的 `gainos:chain-changed` 事件通知，页面不用知道浮窗的存在。
 */
import { ref } from 'vue';

import { gainosApi } from '#/api/gainos';
import { acquisitionStep, type AcquisitionProgress } from '#/utils/acquisition-step';

export const CHAIN_CHANGED_EVENT = 'gainos:chain-changed';

/** 主流程页面：进度浮窗只在这些路径（及其子路径）下显示。 */
const FLOW_PATHS = ['/companies', '/find-buyers', '/tasks', '/runs', '/leads'];

/** 每一步对应的页面（下标 = 步骤 - 1）。第 2、3 步都在买家画像页的工作区里完成。 */
export const STEP_PATHS = ['/companies', '/find-buyers', '/find-buyers', '/tasks', '/leads'] as const;

/** 运行还没到终态的状态：这些之外（RUNNING、排队中……）都算还在跑。 */
const TERMINAL_RUN_STATUSES = new Set(['CANCELLED', 'CANCELED', 'COMPLETED', 'DONE', 'FAILED', 'PARTIAL', 'TIMEOUT']);
const REFRESH_INTERVAL = 30_000;

export function isFlowPath(path: string): boolean {
  return FLOW_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** 页面在关键操作成功后调用：进度浮窗会立刻重新取数。 */
export function notifyChainChanged(): void {
  window.dispatchEvent(new Event(CHAIN_CHANGED_EVENT));
}

const step = ref(1);
const activeIcpId = ref<null | string>(null);
const latestRunId = ref<null | string>(null);
const running = ref(false);
/** 至少取到一次数据后才显示浮窗，免得先画在第 1 步再跳走。 */
const loaded = ref(false);
let timer: null | ReturnType<typeof setInterval> = null;
let requestSeq = 0;

function asArray<T>(value: T[] | { data?: T[] } | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  const inner = (value as { data?: T[] } | undefined)?.data;
  return Array.isArray(inner) ? inner : [];
}

async function refresh(): Promise<void> {
  const request = ++requestSeq;
  const [companies, icps] = await Promise.allSettled([gainosApi.companies(), gainosApi.icps()]);
  if (request !== requestSeq) return;
  // 第 1 步：还没有一份确认过的公司档案。
  if (!asArray(companies.status === 'fulfilled' ? companies.value : null).some((company) => company.status === 'ACTIVE')) {
    setProgress(1, null, null, false);
    return;
  }
  // 第 2 步：档案确认了，还没有生效中的买家画像。
  const active = asArray(icps.status === 'fulfilled' ? icps.value : null).find((icp) => icp.status === 'ACTIVE');
  if (!active) {
    setProgress(2, null, null, false);
    return;
  }
  // 第 3–5 步：看生效画像的最新方案和最近一次寻源（和买家画像、买家线索两页原来的判定一致）。
  const [plans, tasks] = await Promise.allSettled([
    gainosApi.queryPlans(active.id),
    gainosApi.acquisitionTasks(active.id),
  ]);
  if (request !== requestSeq) return;
  const runs = tasks.status === 'fulfilled'
    ? asArray(tasks.value).flatMap((task) => task.runs ?? [])
    : [];
  const progress: AcquisitionProgress = {
    plans: plans.status === 'fulfilled' ? asArray(plans.value) : undefined,
    runs: tasks.status === 'fulfilled' ? runs : undefined,
  };
  const latest = [...runs].sort((a, b) => Date.parse(b.startedAt ?? '') - Date.parse(a.startedAt ?? ''))[0];
  setProgress(
    acquisitionStep(progress),
    active.id,
    latest?.runId ?? null,
    runs.some((run) => !TERMINAL_RUN_STATUSES.has(String(run?.status ?? '').toUpperCase())),
  );
}

function setProgress(next: number, icpId: null | string, runId: null | string, isRunning: boolean): void {
  step.value = next;
  activeIcpId.value = icpId;
  latestRunId.value = runId;
  running.value = isRunning;
  loaded.value = true;
}

/** 正在使用这份数据的浮窗实例数：布局重挂时会出现旧实例还没卸载、新实例已挂上的瞬间，按实例计数避免互相拆台。 */
let users = 0;

function start(): void {
  users += 1;
  if (users > 1) return;
  void refresh();
  if (!timer) timer = setInterval(() => void refresh(), REFRESH_INTERVAL);
  window.addEventListener(CHAIN_CHANGED_EVENT, refresh);
}

function stop(): void {
  users = Math.max(0, users - 1);
  if (users > 0) return;
  if (timer) clearInterval(timer);
  timer = null;
  requestSeq += 1;
  window.removeEventListener(CHAIN_CHANGED_EVENT, refresh);
}

/** 浮窗的高度（px）。滚动区底部留出这么多，页面最后一段不会被盖住。 */
export const FLOW_BAR_HEIGHT = 40;
let spaceUsers = 0;

function writeBarHeight(height: number): void {
  document.documentElement.style.setProperty('--gs-flow-bar-h', `${height}px`);
}

/**
 * 浮窗一挂载就把高度留出来，不等进度数据：否则页面上贴底的元素（如买家画像页的「下一步」）
 * 会先按没有浮窗摆放，等浮窗出来再往上跳一次；组件重新挂载时也能恢复（那时数据已就绪，
 * 「是否显示」不再变化，靠状态变化触发的写入不会发生）。最后一个实例卸载时归零。
 */
function enterSpace(): void {
  spaceUsers += 1;
  writeBarHeight(FLOW_BAR_HEIGHT);
}
function leaveSpace(): void {
  spaceUsers = Math.max(0, spaceUsers - 1);
  if (spaceUsers === 0) writeBarHeight(0);
}

/** 共享的进度状态。`start` / `stop` 由进度浮窗在挂载、卸载时调用（只在主流程页面挂载）。 */
export function useMainChainProgress() {
  return {
    activeIcpId,
    barHeight: FLOW_BAR_HEIGHT,
    enterSpace,
    latestRunId,
    leaveSpace,
    loaded,
    refresh,
    running,
    setSpaceHeight: writeBarHeight,
    start,
    step,
    stepCount: STEP_PATHS.length,
    stop,
  };
}

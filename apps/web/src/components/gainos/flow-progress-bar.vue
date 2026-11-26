<script lang="ts" setup>
/**
 * 主链路进度浮窗（交互建议 1）：进度是跨页面的，不该绑在某个页面上。
 *
 * - 只在主流程页面显示（公司档案、买家画像、挖掘任务、运行页、买家线索），其他页面不占地方；
 * - 贴在内容区底部的细条，五步都能点，点一下跳到对应页面；当前步高亮；
 * - 可以收起成右下角一个小标签，并记住这个选择；
 * - 内容区不够宽时（手机、侧栏展开的平板）收成一句「第 N / 5 步 · 当前步骤」，点开才展开五步。
 *
 * 进度数据在 `use-main-chain-progress` 里，和页面无关。浮窗一挂载，内容区的滚动区底部就留出同样高度
 * （`--gs-flow-bar-h`，不等进度数据）：页面最后一段不会被盖住，贴底的元素也不会等浮窗出来再跳一次。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { preferences, usePreferences } from '@vben/preferences';

import GsSteps from '#/components/gainos/ui/gs-steps.vue';
import {
  STEP_PATHS,
  useMainChainProgress,
} from '#/composables/use-main-chain-progress';
import { $t } from '#/locales';

defineOptions({ name: 'FlowProgressBar' });

const COLLAPSED_KEY = 'gainos.flow-bar.collapsed.v1';
/** 五步横排需要的宽度，和 `GsSteps` 的断点一致。 */
const NARROW_WIDTH = 760;
const STEP_KEYS = [
  'gainos.workspace.stepProfile',
  'gainos.workspace.stepIcp',
  'gainos.workspace.stepPlan',
  'gainos.workspace.stepRun',
  'gainos.workspace.stepJudge',
] as const;

const route = useRoute();
const router = useRouter();
const { isMobile, isSideMode, sidebarCollapsed } = usePreferences();
const {
  barHeight,
  enterSpace,
  latestRunId,
  leaveSpace,
  loaded,
  refresh,
  setSpaceHeight,
  start,
  step,
  stepCount,
  stop,
} = useMainChainProgress();

const visible = computed(() => loaded.value);
const collapsed = ref(readCollapsed());
/** 内容区窄时，五步默认收起，点那一句才展开。 */
const sheetOpen = ref(false);
const narrow = ref(false);
const root = ref<HTMLElement | null>(null);
let observer: null | ResizeObserver = null;
// 浮窗在主流程页面之间切换时不会重新挂载，所以页面一变就重新取数。
watch(() => route.path, () => void refresh());

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}
watch(collapsed, (value) => {
  try {
    localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0');
  } catch {
    // 本地存储不可用：本次会话内仍然有效，刷新后恢复默认。
  }
});

/** 侧栏固定在左边：浮窗从侧栏右边开始，不压住侧栏。 */
const offsetLeft = computed(() => {
  if (!isSideMode.value || isMobile.value) return 0;
  return sidebarCollapsed.value ? (preferences.sidebar.collapseWidth ?? 60) : preferences.sidebar.width;
});

const stepTitle = computed(() => $t(STEP_KEYS[step.value - 1] ?? STEP_KEYS[0]!));
const summary = computed(() =>
  $t('gainos.flowBar.summary', { current: step.value, step: stepTitle.value, total: stepCount }),
);

/**
 * 浮窗占掉的高度写进根变量：滚动区用它留白，买家画像页贴底的「下一步」用它抬高。
 * 挂载时由 `enterSpace` 先留出来；这里只管收起与展开。
 */
watch(collapsed, (value) => setSpaceHeight(value ? 0 : barHeight));

function go(index: number): void {
  const path = STEP_PATHS[index - 1];
  if (!path) return;
  sheetOpen.value = false;
  // 「等待寻源」直达最近一次运行；没有运行记录时去任务列表。
  const target = index === 4 && latestRunId.value ? `/runs/${latestRunId.value}` : path;
  if (route.path !== target) void router.push(target);
}

// 根节点要等第一次取到进度才渲染（v-if），所以不能只在 onMounted 里量宽度：节点出现时再挂监听。
watch(root, (element, previous) => {
  if (previous) observer?.unobserve(previous);
  if (element) observer?.observe(element);
});

onMounted(() => {
  enterSpace();
  start();
  observer = new ResizeObserver((entries) => {
    narrow.value = (entries[0]?.contentRect.width ?? 0) < NARROW_WIDTH;
  });
  if (root.value) observer.observe(root.value);
});
onBeforeUnmount(() => {
  leaveSpace();
  stop();
  observer?.disconnect();
});
</script>

<template>
  <div
    v-if="visible"
    ref="root"
    class="gs-flow"
    :class="{ 'is-collapsed': collapsed }"
    :style="{ left: `${offsetLeft}px` }"
  >
    <!-- 收起后只留右下角一个小标签 -->
    <button
      v-if="collapsed"
      :aria-label="`${$t('gainos.flowBar.expand')}，${summary}`"
      class="gs-flow__pill"
      data-gs="flow-bar-expand"
      type="button"
      @click="collapsed = false"
    >
      {{ summary }}
      <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" viewBox="0 0 16 16" width="14">
        <path d="M3.5 10l4.5-4 4.5 4" />
      </svg>
    </button>

    <div v-else class="gs-flow__bar" data-gs="flow-bar">
      <button
        v-if="narrow"
        :aria-expanded="sheetOpen"
        class="gs-flow__summary"
        data-gs="flow-bar-summary"
        type="button"
        @click="sheetOpen = !sheetOpen"
      >
        {{ summary }}
      </button>
      <div v-if="!narrow" class="gs-flow__steps">
        <GsSteps :current="step" selectable @select="go" />
      </div>
      <!-- 窄屏点开后，五步从底部展开成一列，不占页面高度 -->
      <div v-if="narrow && sheetOpen" class="gs-flow__sheet" data-gs="flow-bar-sheet">
        <GsSteps :current="step" selectable @select="go" />
      </div>
      <button
        :aria-label="$t('gainos.flowBar.collapse')"
        class="gs-flow__toggle"
        data-gs="flow-bar-collapse"
        type="button"
        @click="collapsed = true"
      >
        <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" viewBox="0 0 16 16" width="16">
          <path d="M3.5 6l4.5 4 4.5-4" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.gs-flow {
  position: fixed;
  right: 0;
  bottom: 0;
  z-index: 190;
  left: 0;
}
.gs-flow__bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 16px;
  height: 40px;
  padding: 0 10px 0 20px;
  border-top: 1px solid var(--gs-divider);
  background: var(--gs-surface);
  box-shadow: var(--gs-shadow-float);
}
.gs-flow__steps {
  flex: 1;
  min-width: 0;
}
.gs-flow__pill {
  position: absolute;
  right: 16px;
  bottom: 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--gs-border);
  border-radius: 999px;
  background: var(--gs-surface);
  box-shadow: var(--gs-shadow-float);
  color: var(--gs-fg);
  font-size: 12.5px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
}
.gs-flow__pill:hover,
.gs-flow__toggle:hover {
  color: var(--gs-accent-fg);
}
.gs-flow__summary {
  flex: 1;
  min-width: 0;
  padding: 0;
  overflow: hidden;
  border: 0;
  background: none;
  color: var(--gs-fg);
  font-size: 13px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.gs-flow__toggle {
  display: grid;
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--gs-fg-muted);
  cursor: pointer;
}
.gs-flow__toggle:hover {
  background: var(--gs-surface-2);
  color: var(--gs-fg);
}
.gs-flow__sheet {
  position: absolute;
  right: 0;
  bottom: 100%;
  left: 0;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--gs-divider);
  border-radius: 10px 10px 0 0;
  background: var(--gs-surface);
  box-shadow: var(--gs-shadow-float);
}
.gs-flow :deep(.ant-steps-item-container:focus-visible) {
  outline: 2px solid var(--gs-accent);
  outline-offset: 2px;
  border-radius: 4px;
}
.gs-flow :deep(.ant-steps-item-container:hover .ant-steps-item-title) {
  color: var(--gs-accent-fg);
}
</style>

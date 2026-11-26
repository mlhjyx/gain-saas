<script lang="ts" setup>
/**
 * 主流程进度芯片（PR-UI1）：替代旧版 40px 压底满宽进度条。
 *
 * - 嵌入左侧栏底部（设置上方），不再 position: fixed 横穿主内容区底部切卡片；
 * - `--gs-flow-bar-h` 恒归零 0px，100% 释放正文垂直空间；
 * - 展开侧栏为单行轻芯片（主流程 · 第 N/5 步 · <当前步>），折叠窄栏为图标按钮；
 * - 点击芯片弹出 Popover 展示全部 5 个可点击步骤按钮（当前步 aria-current="step"，
 *   「等待寻源」直达最近运行）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ChevronRight, Circle, CircleCheckBig } from '@vben/icons';
import { Popover } from 'ant-design-vue';

import {
  STEP_PATHS,
  useMainChainProgress,
} from '#/composables/use-main-chain-progress';
import { $t } from '#/locales';

import SdrIcon from './sdr-icon.vue';

defineOptions({ name: 'FlowProgressBar' });

withDefaults(
  defineProps<{
    /** 折叠态窄栏仅展示图标按钮，点击右侧弹出 5 步菜单。 */
    compact?: boolean;
  }>(),
  { compact: false },
);

const STEP_KEYS = [
  'gainos.workspace.stepProfile',
  'gainos.workspace.stepIcp',
  'gainos.workspace.stepPlan',
  'gainos.workspace.stepRun',
  'gainos.workspace.stepJudge',
] as const;

const route = useRoute();
const router = useRouter();
const {
  enterSpace,
  latestRunId,
  leaveSpace,
  loaded,
  refresh,
  start,
  step,
  stepCount,
  stop,
} = useMainChainProgress();

const popoverOpen = ref(false);

// 芯片在主流程页面之间切换时不会重新挂载，所以路由变化时自动重新取数。
watch(
  () => route.path,
  () => {
    popoverOpen.value = false;
    void refresh();
  },
);

const stepItems = computed(() =>
  STEP_KEYS.map((key, idx) => {
    const index = idx + 1;
    const state =
      index < step.value ? 'done' : index === step.value ? 'current' : 'pending';
    return {
      index,
      label: $t(key),
      state,
      stateLabel:
        state === 'done'
          ? $t('gainosUi1.flow.stepCompleted')
          : state === 'current'
            ? $t('gainosUi1.flow.stepCurrent')
            : $t('gainosUi1.flow.stepPending'),
    };
  }),
);

const currentTitle = computed(() => $t(STEP_KEYS[step.value - 1] ?? STEP_KEYS[0]!));

const chipText = computed(() =>
  $t('gainosUi1.flow.chipText', {
    current: step.value,
    step: currentTitle.value,
    total: stepCount,
  }),
);

const chipAria = computed(() =>
  $t('gainosUi1.flow.chipAria', {
    current: step.value,
    step: currentTitle.value,
    total: stepCount,
  }),
);

function go(index: number): void {
  const path = STEP_PATHS[index - 1];
  if (!path) return;
  popoverOpen.value = false;
  // 「等待寻源」直达最近一次运行；没有运行记录时去寻源记录列表。
  const target = index === 4 && latestRunId.value ? `/runs/${latestRunId.value}` : path;
  if (route.path !== target) void router.push(target);
}

onMounted(() => {
  enterSpace();
  start();
});

onBeforeUnmount(() => {
  leaveSpace();
  stop();
});
</script>

<template>
  <div v-if="loaded" class="gs-flow-wrap" data-gs="flow-progress-bar">
    <Popover
      v-model:open="popoverOpen"
      :arrow="false"
      overlay-class-name="gs-flow-pop"
      placement="rightBottom"
      trigger="click"
    >
      <template #content>
        <div
          :aria-label="$t('gainosUi1.flow.popoverTitle')"
          class="gs-flow-menu"
          data-gs="flow-progress-popover"
          role="group"
        >
          <div class="gs-flow-menu__head">
            <div class="gs-flow-menu__title-row">
              <strong class="gs-flow-menu__title">
                {{ $t('gainosUi1.flow.popoverTitle') }}
              </strong>
              <span class="gs-flow-menu__counter">{{ step }} / {{ stepCount }}</span>
            </div>
            <p class="gs-flow-menu__sub">
              {{ $t('gainosUi1.flow.popoverSubtitle') }}
            </p>
          </div>
          <ol class="gs-flow-menu__list">
            <li v-for="item in stepItems" :key="item.index">
              <button
                :aria-current="item.state === 'current' ? 'step' : undefined"
                :class="`is-${item.state}`"
                :data-gs-state="item.state"
                :data-gs-step="item.index"
                class="gs-flow-step"
                data-gs="flow-step-item"
                type="button"
                @click="go(item.index)"
              >
                <span aria-hidden="true" class="gs-flow-step__icon">
                  <CircleCheckBig v-if="item.state === 'done'" :size="15" />
                  <span v-else-if="item.state === 'current'" class="gs-flow-step__dot"></span>
                  <Circle v-else :size="15" />
                </span>
                <span class="gs-flow-step__label">{{ item.label }}</span>
                <span aria-hidden="true" class="gs-flow-step__state">
                  {{ item.stateLabel }}
                </span>
              </button>
            </li>
          </ol>
        </div>
      </template>

      <button
        v-if="compact"
        :aria-expanded="popoverOpen"
        :aria-label="chipAria"
        :title="chipText"
        class="gs-flow-chip gs-flow-chip--compact"
        data-gs="flow-progress-chip"
        type="button"
      >
        <SdrIcon :size="16" name="lucide:compass" />
        <span aria-hidden="true" class="gs-flow-chip__badge"></span>
      </button>

      <button
        v-else
        :aria-expanded="popoverOpen"
        :aria-label="chipAria"
        :title="chipText"
        class="gs-flow-chip"
        data-gs="flow-progress-chip"
        type="button"
      >
        <SdrIcon :size="14" class="gs-flow-chip__icon" name="lucide:compass" />
        <span class="gs-flow-chip__text">{{ chipText }}</span>
        <ChevronRight :size="13" aria-hidden="true" class="gs-flow-chip__arrow" />
      </button>
    </Popover>
  </div>
</template>

<style scoped>
.gs-flow-wrap {
  width: 100%;
  min-width: 0;
  max-width: 100%;
}

.gs-flow-chip {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--gs-border);
  border-radius: 8px;
  background: var(--gs-surface);
  color: var(--gs-fg-2);
  font-size: 12px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;
}

.gs-flow-chip:hover {
  border-color: var(--gs-border-strong);
  color: var(--gs-fg);
}

.gs-flow-chip:focus-visible {
  outline: none;
  box-shadow: var(--gs-shadow-focus);
}

.gs-flow-chip__icon {
  flex: none;
  color: var(--gs-accent-fg);
}

.gs-flow-chip__text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gs-flow-chip__arrow {
  flex: none;
  color: var(--gs-fg-subtle);
}

.gs-flow-chip--compact {
  justify-content: center;
  height: 34px;
  padding: 0;
  border-color: transparent;
  background: transparent;
  color: var(--gs-fg-muted);
}

.gs-flow-chip--compact:hover {
  border-color: transparent;
  background: var(--gs-sidebar-hover);
  color: var(--gs-fg);
}

.gs-flow-chip__badge {
  position: absolute;
  top: 6px;
  right: 7px;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--gs-accent);
}

.gs-flow-menu {
  width: 268px;
  padding: 10px;
  border-radius: 12px;
  background: var(--gs-surface);
}

.gs-flow-menu__head {
  padding: 2px 6px 10px;
  border-bottom: 1px solid var(--gs-border);
  margin-bottom: 6px;
}

.gs-flow-menu__title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.gs-flow-menu__title {
  color: var(--gs-fg);
  font-size: 13px;
  font-weight: 600;
}

.gs-flow-menu__counter {
  color: var(--gs-fg-muted);
  font-size: 11.5px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.gs-flow-menu__sub {
  margin: 2px 0 0;
  color: var(--gs-fg-muted);
  font-size: 11.5px;
  line-height: 16px;
}

.gs-flow-menu__list {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.gs-flow-step {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 34px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--gs-fg-2);
  font-size: 13px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}

.gs-flow-step:hover {
  background: var(--gs-surface-2);
  color: var(--gs-fg);
}

.gs-flow-step:focus-visible {
  outline: none;
  box-shadow: var(--gs-shadow-focus);
}

.gs-flow-step.is-current {
  background: var(--gs-accent-soft);
  color: var(--gs-fg);
}

.gs-flow-step__icon {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  flex: none;
}

.gs-flow-step.is-done .gs-flow-step__icon {
  color: var(--gs-success-fg);
}

.gs-flow-step.is-pending .gs-flow-step__icon {
  color: var(--gs-fg-placeholder);
}

.gs-flow-step__dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: var(--gs-accent);
  box-shadow: 0 0 0 3px var(--gs-accent-soft);
}

.gs-flow-step__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gs-flow-step__state {
  flex: none;
  font-size: 11px;
  font-weight: 500;
  color: var(--gs-fg-subtle);
}

.gs-flow-step.is-current .gs-flow-step__state {
  color: var(--gs-accent-fg);
}

.gs-flow-step.is-done .gs-flow-step__state {
  color: var(--gs-success-fg);
}
</style>

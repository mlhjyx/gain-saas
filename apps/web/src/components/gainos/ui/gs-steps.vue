<script lang="ts" setup>
/**
 * 主链路步骤条（PRD §14.1）：完善档案 → 设定买家画像 → 确认寻源方案 →
 * 等待寻源 → 判断线索。买家线索、找买家共用。
 *
 * 不显示序号（用户不知道「5」指什么）：已完成的步骤是默认的对勾；当前步用
 * 「蓝底圆 + 白点」标记「你现在在这里」；还没走到的步骤是一个空心圆。
 * antdv Steps：给 item.icon 传 VNode 会替换掉默认序号，但这一步会被标成
 * ant-steps-item-custom 并取消默认蓝底圆圈，所以圆底要在这里自己画。
 */
import { computed, h, onBeforeUnmount, onMounted, onUpdated, ref } from 'vue';

import { Steps } from 'ant-design-vue';

import { $t } from '#/locales';

defineOptions({ name: 'GsSteps' });

const props = defineProps<{ current: number }>();

const STEP_KEYS = [
  'gainos.workspace.stepProfile',
  'gainos.workspace.stepIcp',
  'gainos.workspace.stepPlan',
  'gainos.workspace.stepRun',
  'gainos.workspace.stepJudge',
] as const;

const labels = computed(() => STEP_KEYS.map((key) => $t(key)));

const circle = (style: Record<string, string>) =>
  h('span', {
    'aria-hidden': 'true',
    style: {
      borderRadius: '9999px',
      boxSizing: 'border-box',
      display: 'block',
      height: '24px',
      width: '24px',
      ...style,
    },
  });
const CURRENT_ICON = circle({
  background: 'radial-gradient(circle, #fff 0 4px, transparent 4.5px), var(--gs-accent-cta)',
});
const WAIT_ICON = circle({ border: '1px solid var(--gs-border-strong)' });

const items = computed(() =>
  labels.value.map((title, index) => {
    if (index === props.current - 1) return { icon: CURRENT_ICON, title };
    if (index > props.current - 1) return { icon: WAIT_ICON, title };
    return { title };
  }),
);
const root = ref<HTMLElement | null>(null);

/**
 * antdv 只要内部挂了变更回调（它总是挂）就把每一步渲染成可聚焦的「按钮」，
 * 而这里点击不做任何事。步骤条只是进度指示：去掉这层假按钮语义，
 * 读屏软件不会报出 5 个没用的按钮，按名称找按钮的用例也不会被步骤名干扰。
 */
function neutralizeItemRoles(): void {
  root.value?.querySelectorAll<HTMLElement>('.ant-steps-item-container').forEach((el) => {
    el.removeAttribute('role');
    el.removeAttribute('tabindex');
  });
}
/** 五步横排（图标 + 不折行的标题 + 连接线）大约需要 760px。内容区更窄时——手机、
 * 侧栏展开的平板——改竖排，否则最右边的步骤会被裁掉。antd 自带的 responsive 只看
 * 视口宽度（<576px），侧栏占掉一截时判断不准，这里自己量容器。 */
const STEP_HORIZONTAL_MIN = 760;
const vertical = ref(false);
let observer: null | ResizeObserver = null;
onMounted(() => {
  neutralizeItemRoles();
  if (!root.value) return;
  observer = new ResizeObserver((entries) => {
    vertical.value = (entries[0]?.contentRect.width ?? 0) < STEP_HORIZONTAL_MIN;
  });
  observer.observe(root.value);
});
onBeforeUnmount(() => observer?.disconnect());
onUpdated(neutralizeItemRoles);
</script>

<template>
  <div
    :aria-label="$t('gainos.workspace.stepProgress', { current, total: STEP_KEYS.length })"
    class="gs-steps"
    data-gs="steps"
    role="group"
    ref="root"
  >
    <Steps
      :current="current - 1"
      :direction="vertical ? 'vertical' : 'horizontal'"
      :items="items"
      :responsive="false"
      size="small"
    />
  </div>
</template>

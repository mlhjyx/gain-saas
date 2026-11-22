import { ref, watch, type Ref } from 'vue';

/**
 * pass3 C3：数字 count-up 滚动（requestAnimationFrame，无新依赖）。
 * 目标值变化时从当前显示值缓动到新值；非数字目标直接透传。
 */
export function useCountUp(target: Ref<number>, duration = 600): Ref<number> {
  const display = ref(0);
  let frame = 0;
  let from = 0;

  function ease(t: number): number {
    return 1 - (1 - t) ** 3;
  }

  function animate(to: number): void {
    if (frame) cancelAnimationFrame(frame);
    const start = performance.now();
    from = display.value;
    if (from === to) return;
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      display.value = Math.round(from + (to - from) * ease(progress));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }

  watch(
    target,
    (value) => {
      if (typeof value === 'number' && Number.isFinite(value)) animate(value);
      else display.value = 0;
    },
    { immediate: true },
  );

  return display;
}

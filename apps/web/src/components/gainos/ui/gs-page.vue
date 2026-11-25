<script lang="ts" setup>
/**
 * 页面头（设计系统 §3）。
 *
 * 默认是「渐变页头」：通栏的品牌蓝极浅渐变带 + 右侧装饰插画，H1 28/600 +
 * 副标题。底部预留 64px 渐变淡出区，下一块面板用 `-mt-12` 上移压进来，
 * 形成「白卡浮在渐变上」的层次。`:hero="false"` 回到素净的 H1 页头
 * （设置类页面用）。
 *
 * 插画是内联 SVG，颜色全部走 --gs-hero-* 令牌（明暗各一套）；不用渐变填充
 * url()，保证渲染态取色扫描能归类。
 */
withDefaults(
  defineProps<{
    hero?: boolean;
    /** 阶段/上下文字标，例如「第 2 步 · 设定目标客户画像」 */
    kicker?: string;
    subtitle?: string;
    title: string;
  }>(),
  { hero: true, kicker: undefined, subtitle: undefined },
);
</script>

<template>
  <header class="gs-page" :class="{ 'gs-page--hero': hero }" data-gs="page-header">
    <svg
      v-if="hero && !$slots.actions"
      aria-hidden="true"
      class="gs-page__art"
      fill="none"
      focusable="false"
      viewBox="0 0 200 132"
    >
      <rect
        class="gs-page__art-card gs-page__art-card--back"
        height="76"
        rx="14"
        transform="rotate(8 129 46)"
        width="122"
        x="68"
        y="8"
      />
      <rect
        class="gs-page__art-card gs-page__art-card--mid"
        height="82"
        rx="14"
        transform="rotate(3 110 63)"
        width="132"
        x="44"
        y="22"
      />
      <rect
        class="gs-page__art-card gs-page__art-card--front"
        height="92"
        rx="14"
        width="148"
        x="12"
        y="36"
      />
      <circle class="gs-page__art-accent" cx="52" cy="78" r="17" />
      <circle class="gs-page__art-figure" cx="52" cy="73" r="6.5" />
      <path
        class="gs-page__art-figure"
        d="M40.5 88c2.4-6.2 6.6-9.3 11.5-9.3s9.1 3.1 11.5 9.3a17 17 0 0 1-23 0z"
      />
      <rect
        class="gs-page__art-line gs-page__art-line--strong"
        height="7"
        rx="3.5"
        width="60"
        x="82"
        y="68"
      />
      <rect class="gs-page__art-line" height="7" rx="3.5" width="44" x="82" y="84" />
      <circle class="gs-page__art-accent" cx="152" cy="122" r="11" />
      <path class="gs-page__art-check" d="M147 122l3.6 3.6 6.4-7.2" />
    </svg>

    <div class="gs-page__main">
      <p v-if="kicker" class="gs-page__kicker">{{ kicker }}</p>
      <h1 class="gs-page__title">{{ title }}</h1>
      <p v-if="subtitle" class="gs-page__subtitle">{{ subtitle }}</p>
    </div>
    <div v-if="$slots.actions" class="gs-page__actions">
      <slot name="actions"></slot>
    </div>
  </header>
</template>

<style scoped>
.gs-page {
  position: relative;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.gs-page__main {
  min-width: 0;
}
.gs-page__kicker {
  margin: 0 0 6px;
  color: var(--gs-accent-strong);
  font-size: 12px;
  font-weight: 500;
}
.gs-page__title {
  margin: 0;
  color: var(--gs-fg);
  font-size: 20px;
  line-height: 28px;
  font-weight: 600;
  letter-spacing: -0.011em;
}
.gs-page__subtitle {
  margin: 6px 0 0;
  max-width: 720px;
  color: var(--gs-fg-muted);
  font-size: 13px;
  line-height: 20px;
}
.gs-page__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* ── 渐变页头 ─────────────────────────────────────────────────────────── */
.gs-page--hero {
  isolation: isolate;
  overflow: hidden;
  align-items: center;
  margin-inline: calc(var(--gs-page-pad) * -1);
  padding: 18px var(--gs-page-pad) 64px;
  background:
    radial-gradient(46% 130% at 6% -34%, var(--gs-hero-glow-side) 0%, transparent 62%),
    radial-gradient(52% 150% at 82% -30%, var(--gs-hero-glow) 0%, transparent 68%),
    linear-gradient(
      180deg,
      var(--gs-hero-tint) 0%,
      var(--gs-hero-tint-soft) 54%,
      transparent 100%
    );
}
.gs-page--hero .gs-page__title {
  font-size: 28px;
  line-height: 36px;
  letter-spacing: -0.02em;
}
.gs-page--hero .gs-page__subtitle {
  margin-top: 4px;
}
.gs-page__art {
  position: absolute;
  top: 0;
  inset-inline-end: calc(var(--gs-page-pad) + 8px);
  width: 200px;
  overflow: visible;
  pointer-events: none;
  filter: drop-shadow(0 14px 20px rgba(51, 92, 255, 0.16));
}
.gs-page__art-card {
  fill: var(--gs-hero-card);
  stroke: var(--gs-hero-card-stroke);
  stroke-width: 1;
}
.gs-page__art-card--back {
  opacity: 0.55;
}
.gs-page__art-card--mid {
  opacity: 0.78;
}
.gs-page__art-accent {
  fill: var(--gs-hero-accent);
}
.gs-page__art-figure {
  fill: var(--gs-hero-figure);
}
.gs-page__art-line {
  fill: var(--gs-hero-line);
}
.gs-page__art-line--strong {
  fill: var(--gs-hero-line-strong);
}
.gs-page__art-check {
  stroke: #fff;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
}

@media (max-width: 1023px) {
  .gs-page__art {
    display: none;
  }
}
</style>

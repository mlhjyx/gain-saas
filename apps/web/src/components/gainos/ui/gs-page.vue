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
 * url()，保证渲染态取色扫描能归类。`art` 用来区分页面语义：买家线索是
 * 靶心、找买家是地球与定位、公司档案是楼宇与盾牌，底纹也各不一样，避免
 * 几个列表页的页头长得一模一样。
 */
withDefaults(
  defineProps<{
    /** 页面专属插画与底纹；不传时用通用人物卡片。 */
    art?: 'company' | 'default' | 'find-buyers' | 'leads';
    hero?: boolean;
    /** 阶段/上下文字标，例如「第 2 步 · 设定买家画像」 */
    kicker?: string;
    subtitle?: string;
    title: string;
  }>(),
  { art: 'default', hero: true, kicker: undefined, subtitle: undefined },
);
</script>

<template>
  <header
    class="gs-page"
    :class="[{ 'gs-page--hero': hero }, `gs-page--${art}`]"
    data-gs="page-header"
  >
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

      <!-- 公司档案：楼宇（企业主体） -->
      <g v-if="art === 'company'">
        <rect class="gs-page__art-accent" height="33" rx="5" width="33" x="36" y="61" />
        <rect class="gs-page__art-window" height="5" rx="1" width="6" x="42" y="67" />
        <rect class="gs-page__art-window" height="5" rx="1" width="6" x="57" y="67" />
        <rect class="gs-page__art-window" height="5" rx="1" width="6" x="42" y="76" />
        <rect class="gs-page__art-window" height="5" rx="1" width="6" x="57" y="76" />
        <rect class="gs-page__art-window" height="8" rx="1" width="10" x="47.5" y="86" />
      </g>

      <!-- 找买家：地球 + 经纬线（海外市场） -->
      <g v-else-if="art === 'find-buyers'">
        <circle class="gs-page__art-accent" cx="52" cy="78" r="17" />
        <ellipse class="gs-page__art-ring" cx="52" cy="78" rx="6" ry="12" />
        <path class="gs-page__art-ring" d="M40.5 78h23" />
        <path class="gs-page__art-ring" d="M43.5 70h17M43.5 86h17" />
      </g>

      <!-- 买家线索：靶心（筛选精准线索） -->
      <g v-else-if="art === 'leads'">
        <circle class="gs-page__art-accent" cx="52" cy="78" r="17" />
        <circle class="gs-page__art-ring" cx="52" cy="78" r="9.5" />
        <circle class="gs-page__art-figure" cx="52" cy="78" r="3.4" />
      </g>

      <!-- 通用：人物/客户 -->
      <g v-else>
        <circle class="gs-page__art-accent" cx="52" cy="78" r="17" />
        <circle class="gs-page__art-figure" cx="52" cy="73" r="6.5" />
        <path
          class="gs-page__art-figure"
          d="M40.5 88c2.4-6.2 6.6-9.3 11.5-9.3s9.1 3.1 11.5 9.3a17 17 0 0 1-23 0z"
        />
      </g>

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
      <path
        v-if="art === 'find-buyers'"
        class="gs-page__art-figure"
        d="M152 116.4c2.8 3.3 4.2 5.3 4.2 6.5a4.2 4.2 0 0 1-8.4 0c0-1.2 1.4-3.2 4.2-6.5z"
      />
      <circle v-if="art === 'find-buyers'" class="gs-page__art-dot" cx="152" cy="122.4" r="1.5" />
      <path
        v-else-if="art === 'company'"
        class="gs-page__art-shield"
        d="M152 115.4l5.2 2v3.2c0 2.7-2.1 4.8-5.2 5.8-3.1-1-5.2-3.1-5.2-5.8v-3.2z"
      />
      <path v-else class="gs-page__art-check" d="M147 122l3.6 3.6 6.4-7.2" />
    </svg>

    <div class="gs-page__main">
      <!-- 大插画在 1023px 以下隐藏，用同语义的小图标补位，手机上也能区分页面。 -->
      <span v-if="hero && art !== 'default'" aria-hidden="true" class="gs-page__mark">
        <svg fill="none" focusable="false" viewBox="0 0 24 24">
          <g
            v-if="art === 'company'"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.6"
          >
            <path d="M4 20h16M6 20V6.6L12 4v16M12 20V9h6v11" />
            <path d="M8.6 8h.01M8.6 11.5h.01M8.6 15h.01M15 12h.01M15 15.5h.01" />
          </g>
          <g
            v-else-if="art === 'find-buyers'"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-width="1.6"
          >
            <circle cx="12" cy="12" r="8" />
            <ellipse cx="12" cy="12" rx="3.4" ry="8" />
            <path d="M4 12h16M5.8 8h12.4M5.8 16h12.4" />
          </g>
          <g v-else stroke="currentColor" stroke-width="1.6">
            <circle cx="12" cy="12" r="8" />
            <circle cx="12" cy="12" r="4" />
            <circle cx="12" cy="12" fill="currentColor" r="1.6" stroke="none" />
          </g>
        </svg>
      </span>
      <div class="gs-page__text">
        <p v-if="kicker" class="gs-page__kicker">{{ kicker }}</p>
        <h1 class="gs-page__title">{{ title }}</h1>
        <p v-if="subtitle" class="gs-page__subtitle">{{ subtitle }}</p>
      </div>
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
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}
.gs-page__text {
  min-width: 0;
}
.gs-page__mark {
  display: none;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: 1px solid var(--gs-accent-soft-border);
  border-radius: 12px;
  background: var(--gs-accent-soft);
  color: var(--gs-accent-strong);
}
.gs-page__mark svg {
  width: 22px;
  height: 22px;
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
.gs-page--hero .gs-page__main,
.gs-page--hero .gs-page__actions {
  position: relative;
  z-index: 2;
}
.gs-page--hero .gs-page__title {
  font-size: 28px;
  line-height: 36px;
  letter-spacing: -0.02em;
}
.gs-page--hero .gs-page__subtitle {
  margin-top: 4px;
}

/* 每个业务页一条不同的极浅底纹，和插画一起承担「我在哪」的识别。 */
.gs-page--hero::before {
  position: absolute;
  z-index: 0;
  inset: 0;
  content: '';
  pointer-events: none;
}
.gs-page--leads::before {
  background-image: radial-gradient(var(--gs-hero-line-strong) 1px, transparent 1.2px);
  background-size: 18px 18px;
  opacity: 0.34;
  mask-image: linear-gradient(90deg, transparent 30%, #000 78%);
}
.gs-page--find-buyers::before {
  background-image: repeating-radial-gradient(
    circle at 84% 18%,
    transparent 0 26px,
    var(--gs-hero-line) 26px 27px
  );
  opacity: 0.5;
  mask-image: linear-gradient(90deg, transparent 32%, #000 100%);
}
.gs-page--company::before {
  background-image:
    linear-gradient(var(--gs-hero-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--gs-hero-line) 1px, transparent 1px);
  background-size: 26px 26px;
  opacity: 0.38;
  mask-image: linear-gradient(90deg, transparent 30%, #000 86%);
}

.gs-page__art {
  position: absolute;
  top: 0;
  z-index: 1;
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
.gs-page__art-check,
.gs-page__art-shield,
.gs-page__art-ring {
  stroke: #fff;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.gs-page__art-check {
  stroke-width: 2;
}
.gs-page__art-shield {
  stroke-width: 1.4;
}
.gs-page__art-ring {
  fill: none;
  stroke-width: 1.6;
}
.gs-page__art-window {
  fill: #fff;
  opacity: 0.92;
}
.gs-page__art-dot {
  fill: var(--gs-hero-accent);
}

@media (max-width: 1023px) {
  .gs-page__art {
    display: none;
  }
  .gs-page__mark {
    display: inline-flex;
  }
}
</style>

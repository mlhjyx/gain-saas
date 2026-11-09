<script lang="ts" setup>
import { computed } from 'vue';

import { useAntdDesignTokens } from '@vben/hooks';
import { preferences, usePreferences } from '@vben/preferences';

import { App, ConfigProvider, theme } from 'ant-design-vue';

import { antdLocale } from '#/locales';

defineOptions({ name: 'App' });

const { isDark } = usePreferences();
const { tokens } = useAntdDesignTokens();

/**
 * GainOS 品牌令牌桥：antd 组件的色板与 gainos.css 的 --gs-* 同源取值。
 * 这里用 TS 常量按 isDark 选择（曾尝试运行时读 getComputedStyle，
 * 但 .dark 类的施加与 computed 重算存在时序竞态，会读到切换前的颜色）。
 * 修改品牌色时需同步 gainos.css 的两套 --gs-* 令牌。
 */
const GS_BRAND = {
  light: {
    accent: '#00b96b',
    accentCta: '#007a47',
    accentCtaHover: '#00693f',
    bg: '#f7f8fa',
    surface: '#ffffff',
    border: '#eceef2',
    fg: '#0f172a',
    fg2: '#374151',
    fgMuted: '#6b7280',
    fgSubtle: '#9ca3af',
    danger: '#b91c1c',
    warn: '#b45309',
  },
  dark: {
    accent: '#14c983',
    accentCta: '#14c983',
    accentCtaHover: '#34d399',
    bg: '#0b0f16',
    surface: '#141922',
    border: '#232b37',
    fg: '#e8ebf0',
    fg2: '#c4cbd6',
    fgMuted: '#98a1b1',
    fgSubtle: '#6f7888',
    danger: '#f87171',
    warn: '#fbbf24',
  },
} as const;

const brandTokens = computed(() => {
  const c = isDark.value ? GS_BRAND.dark : GS_BRAND.light;
  return {
    // CTA 绿（#007a47）：白字按钮的 AA 达标色，与 vben 壳层 colorPrimary 同值；
    // #00b96b 只做链接/焦点/描边，不做白字底色。
    colorPrimary: c.accentCta,
    colorInfo: c.accentCta,
    colorLink: c.accent,
    colorLinkHover: c.accentCta,
    colorPrimaryHover: c.accentCtaHover,
    colorSuccess: c.accent,
    colorError: c.danger,
    colorWarning: c.warn,
    colorText: c.fg,
    colorTextHeading: c.fg,
    colorTextBase: c.fg,
    colorTextSecondary: c.fg2,
    colorTextTertiary: c.fgMuted,
    colorTextQuaternary: c.fgSubtle,
    colorBgContainer: c.surface,
    colorBgElevated: c.surface,
    colorBgLayout: c.bg,
    colorBorder: c.border,
    colorBorderSecondary: c.border,
    borderRadius: 10,
    controlHeight: 38,
  };
});

const tokenTheme = computed(() => {
  const algorithm = isDark.value
    ? [theme.darkAlgorithm]
    : [theme.defaultAlgorithm];

  // antd 紧凑模式算法
  if (preferences.app.compact) {
    algorithm.push(theme.compactAlgorithm);
  }

  return {
    algorithm,
    token: { ...tokens, ...brandTokens.value },
  };
});
</script>

<template>
  <ConfigProvider :locale="antdLocale" :theme="tokenTheme">
    <App>
      <RouterView />
    </App>
  </ConfigProvider>
</template>

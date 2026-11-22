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
 * 数值来源：docs/evidence/ui-restyle/token-mapping.md（AgentSDR AlignUI token）。
 * 这里用 TS 常量按 isDark 选择（曾尝试运行时读 getComputedStyle，
 * 但 .dark 类的施加与 computed 重算存在时序竞态，会读到切换前的颜色）。
 * 修改品牌色时需同步 gainos.css 的两套 --gs-* 令牌。
 *
 * 对比度口径：主行动 #335CFF + 白字 5.10:1；错误/警告/成功文字用 600/700 档，
 * 不用 500 档做正文色（500 档只做图标、边框、浅底）。
 */
const GS_BRAND = {
  light: {
    primary: '#335CFF',
    primaryHover: '#2547D0',
    primaryActive: '#1F3BAD',
    primaryBg: '#EBF1FF',
    primaryBorder: '#C0D5FF',
    link: '#335CFF',
    linkHover: '#2547D0',
    linkActive: '#1F3BAD',
    success: '#1FC16B',
    successText: '#1A7544',
    successBg: 'rgba(31, 193, 107, 0.10)',
    successBorder: '#A7E8C5',
    warning: '#FA7319',
    warningText: '#B75310',
    warningBg: 'rgba(250, 115, 25, 0.10)',
    warningBorder: '#F9C9A8',
    error: '#FB3748',
    errorText: '#D02533',
    errorBg: 'rgba(251, 55, 72, 0.08)',
    errorBorder: '#FFC3C8',
    bgBase: '#FFFFFF',
    bgContainer: '#FFFFFF',
    bgElevated: '#FFFFFF',
    bgLayout: '#F7F7F7',
    bgSpotlight: '#171717',
    tableHeaderBg: '#F7F7F7',
    fg: '#171717',
    fgSecondary: '#5C5C5C',
    fgTertiary: '#7B7B7B',
    fgQuaternary: '#A3A3A3',
    fgDisabled: '#D1D1D1',
    tooltipText: '#FFFFFF',
    border: '#EBEBEB',
    borderSecondary: '#F5F5F5',
    split: '#F5F5F5',
    fillSecondary: '#F5F5F5',
    fillTertiary: '#F7F7F7',
    fillQuaternary: '#FAFAFA',
    shadow: '0 1px 2px 0 rgba(10, 13, 20, 0.031)',
    shadowSecondary: '0 16px 32px -12px rgba(14, 18, 27, 0.10)',
    shadowTertiary: '0 2px 4px rgba(27, 28, 29, 0.039)',
  },
  dark: {
    primary: '#335CFF',
    primaryHover: '#4D82FF',
    primaryActive: '#2547D0',
    primaryBg: 'rgba(51, 92, 255, 0.16)',
    primaryBorder: 'rgba(51, 92, 255, 0.24)',
    link: '#4D82FF',
    linkHover: '#97BAFF',
    linkActive: '#C0D5FF',
    success: '#3EE089',
    successText: '#3EE089',
    successBg: 'rgba(62, 224, 137, 0.12)',
    successBorder: 'rgba(62, 224, 137, 0.24)',
    warning: '#FFA468',
    warningText: '#FFA468',
    warningBg: 'rgba(255, 164, 104, 0.12)',
    warningBorder: 'rgba(255, 164, 104, 0.24)',
    error: '#FF6875',
    errorText: '#FF6875',
    errorBg: 'rgba(255, 104, 117, 0.12)',
    errorBorder: 'rgba(255, 104, 117, 0.32)',
    bgBase: '#171717',
    bgContainer: '#1C1C1C',
    bgElevated: '#262626',
    bgLayout: '#171717',
    bgSpotlight: '#FFFFFF',
    tableHeaderBg: '#1C1C1C',
    fg: '#FFFFFF',
    fgSecondary: '#A3A3A3',
    fgTertiary: '#7B7B7B',
    fgQuaternary: '#5C5C5C',
    fgDisabled: '#5C5C5C',
    tooltipText: '#171717',
    border: '#262626',
    borderSecondary: '#333333',
    split: '#262626',
    fillSecondary: '#262626',
    fillTertiary: '#1C1C1C',
    fillQuaternary: '#171717',
    shadow: '0 1px 2px 0 rgba(0, 0, 0, 0.45)',
    shadowSecondary: '0 16px 32px -12px rgba(0, 0, 0, 0.65)',
    shadowTertiary: '0 2px 4px rgba(0, 0, 0, 0.5)',
  },
} as const;

const brandTokens = computed(() => {
  const c = isDark.value ? GS_BRAND.dark : GS_BRAND.light;
  return {
    colorPrimary: c.primary,
    colorPrimaryHover: c.primaryHover,
    colorPrimaryActive: c.primaryActive,
    colorPrimaryBg: c.primaryBg,
    colorPrimaryBorder: c.primaryBorder,
    colorInfo: c.primary,
    colorInfoText: isDark.value ? c.link : c.primaryActive,
    colorInfoBg: c.primaryBg,
    colorInfoBorder: c.primaryBorder,
    colorLink: c.link,
    colorLinkHover: c.linkHover,
    colorLinkActive: c.linkActive,
    colorSuccess: c.success,
    colorSuccessText: c.successText,
    colorSuccessBg: c.successBg,
    colorSuccessBorder: c.successBorder,
    colorWarning: c.warning,
    colorWarningText: c.warningText,
    colorWarningBg: c.warningBg,
    colorWarningBorder: c.warningBorder,
    colorError: c.error,
    colorErrorText: c.errorText,
    colorErrorBg: c.errorBg,
    colorErrorBorder: c.errorBorder,
    colorText: c.fg,
    colorTextHeading: c.fg,
    colorTextBase: c.fg,
    colorTextSecondary: c.fgSecondary,
    colorTextTertiary: c.fgTertiary,
    colorTextQuaternary: c.fgQuaternary,
    colorTextDisabled: c.fgDisabled,
    colorBgBase: c.bgBase,
    colorBgContainer: c.bgContainer,
    colorBgElevated: c.bgElevated,
    colorBgLayout: c.bgLayout,
    colorBgSpotlight: c.bgSpotlight,
    colorBorder: c.border,
    colorBorderSecondary: c.borderSecondary,
    colorSplit: c.split,
    colorFillSecondary: c.fillSecondary,
    colorFillTertiary: c.fillTertiary,
    colorFillQuaternary: c.fillQuaternary,
    borderRadius: 10,
    borderRadiusLG: 20,
    borderRadiusSM: 10,
    controlHeight: 40,
    controlHeightLG: 44,
    controlHeightSM: 32,
    fontFamily:
      "system-ui, -apple-system, 'Segoe UI', Arial, Helvetica, sans-serif",
    fontSize: 14,
    lineHeight: 1.4286,
    fontWeightStrong: 500,
    wireframe: false,
    boxShadow: c.shadow,
    boxShadowSecondary: c.shadowSecondary,
    boxShadowTertiary: c.shadowTertiary,
  };
});

function componentTokens(c: (typeof GS_BRAND)['light' | 'dark']) {
  return {
    Button: {
      borderRadius: 10,
      controlHeight: 40,
      controlHeightLG: 44,
      controlHeightSM: 32,
    },
    Card: { borderRadiusLG: 10 },
    Modal: { borderRadiusLG: 20 },
    Drawer: { borderRadiusLG: 20 },
    Input: { borderRadius: 10, controlHeight: 40 },
    InputNumber: { borderRadius: 10, controlHeight: 40 },
    Select: { borderRadius: 10, controlHeight: 40 },
    DatePicker: { borderRadius: 10, controlHeight: 40 },
    Table: {
      headerBg: c.tableHeaderBg,
      headerColor: c.fgSecondary,
      rowHoverBg: c.fillTertiary,
      borderColor: c.split,
      headerSplitColor: c.split,
    },
    Tooltip: {
      colorBgSpotlight: c.bgSpotlight,
      colorTextLightSolid: c.tooltipText,
    },
  };
}

const tokenTheme = computed(() => {
  const c = isDark.value ? GS_BRAND.dark : GS_BRAND.light;
  const algorithm = isDark.value
    ? [theme.darkAlgorithm]
    : [theme.defaultAlgorithm];

  // antd 紧凑模式算法
  if (preferences.app.compact) {
    algorithm.push(theme.compactAlgorithm);
  }

  return {
    algorithm,
    components: componentTokens(c),
    token: { ...tokens, ...brandTokens.value },
  };
});
</script>

<template>
  <ConfigProvider
    :auto-insert-space-in-button="false"
    :locale="antdLocale"
    :theme="tokenTheme"
  >
    <App>
      <RouterView />
    </App>
  </ConfigProvider>
</template>

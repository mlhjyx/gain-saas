<script lang="ts" setup>
import { computed } from 'vue';

import { useAntdDesignTokens } from '@vben/hooks';
import { preferences, usePreferences } from '@vben/preferences';

import { App, ConfigProvider, theme } from 'ant-design-vue';

import FeedbackInit from '#/components/feedback-init.vue';
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
    primaryHover: '#3559E9',
    primaryActive: '#3559E9',
    primaryBg: '#EBF1FF',
    primaryBorder: '#C0D5FF',
    link: '#335CFF',
    linkHover: '#3559E9',
    linkActive: '#3559E9',
    success: '#1A7544',
    successText: '#171717',
    successBg: 'rgba(26, 117, 68, 0.10)',
    successBorder: 'rgba(26, 117, 68, 0.24)',
    warning: '#B75310',
    warningText: '#B75310',
    warningBg: 'rgba(183, 83, 16, 0.10)',
    warningBorder: 'rgba(183, 83, 16, 0.24)',
    error: '#D02533',
    errorText: '#D02533',
    errorBg: 'rgba(208, 37, 51, 0.08)',
    errorBorder: 'rgba(208, 37, 51, 0.24)',
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
    shadow: '0 1px 2px 0 rgba(10,10,10,.031)',
    shadowSecondary: '0 16px 32px -12px rgba(10,10,10,.10)',
    shadowTertiary: '0 2px 4px rgba(27, 28, 29, 0.039)',
  },
  dark: {
    primary: '#335CFF',
    primaryHover: '#3559E9',
    primaryActive: '#3559E9',
    primaryBg: 'rgba(51, 92, 255, 0.16)',
    primaryBorder: 'rgba(51, 92, 255, 0.24)',
    link: '#335CFF',
    linkHover: '#3559E9',
    linkActive: '#3559E9',
    success: '#1A7544',
    successText: '#FFFFFF',
    successBg: 'rgba(26, 117, 68, 0.18)',
    successBorder: 'rgba(26, 117, 68, 0.32)',
    warning: '#B75310',
    warningText: '#B75310',
    warningBg: 'rgba(183, 83, 16, 0.18)',
    warningBorder: 'rgba(183, 83, 16, 0.32)',
    error: '#D02533',
    errorText: '#D02533',
    errorBg: 'rgba(208, 37, 51, 0.18)',
    errorBorder: 'rgba(208, 37, 51, 0.32)',
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
    borderRadiusLG: 10,
    borderRadiusSM: 10,
    controlHeight: 40,
    controlHeightLG: 44,
    controlHeightSM: 32,
    fontFamily:
      "system-ui, -apple-system, 'Segoe UI', Arial, Helvetica, sans-serif",
    fontSize: 14,
    fontSizeSM: 12,
    lineHeight: 1.4286,
    fontWeightStrong: 500,
    // 企业级观感：动效只表现状态变化，不做位移动画（≤150ms）
    motionDurationMid: '0.15s',
    motionDurationSlow: '0.2s',
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
    Card: { borderRadiusLG: 10, paddingLG: 24 },
    // 弹层与全站统一 10px（原 20 属于圆润风格，企业系统改为方正）
    Modal: { borderRadiusLG: 10 },
    Drawer: { borderRadiusLG: 10 },
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
      // 企业数据表：13px 正文，行高由 size=middle + padding 派生（≈48px）
      fontSize: 13,
    },
    Tag: { borderRadiusSM: 6 },
    Alert: { borderRadiusLG: 10 },
    Notification: { borderRadiusLG: 10 },
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
      <FeedbackInit />
      <RouterView />
    </App>
  </ConfigProvider>
</template>

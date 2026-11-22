import {
  appCopyrightPreferences,
  defineOverridesPreferences,
  definePreferencesExtension,
} from '@vben/preferences';

/**
 * 标记走 public/ 下的稳定路径,不用打包后的 data URI:
 * vben 会把偏好(含 logo.source)持久化,k 值/内联串一旦变化,
 * 老访客的 localStorage 仍指向旧图。稳定路径随文件内容更新。
 */
// pass3：URL 带版本号做缓存击穿——logo 内容已改品牌蓝，但浏览器会按同 URL
// 服务旧的绿色 SVG；老访客（含用户本人）必须拿到新图。
const LOGO_SRC = '/logo-gainos.svg?v=pass3';

interface WebAntdPreferencesExtension {
  defaultTableSize: number;
  enableFormFullscreen: boolean;
  reportTitle: string;
  tenantMode: 'multi' | 'single';
}

/**
 * @description 项目配置文件
 * 只需要覆盖项目中的一部分配置，不需要的配置不用覆盖，会自动使用默认配置
 * !!! 更改配置后请清空缓存，否则可能不生效
 */
export const overridesPreferences = defineOverridesPreferences({
  // overrides
  app: {
    name: import.meta.env.VITE_APP_TITLE || 'GainOS',
    defaultHomePath: '/workspace',
    // pass3：布局钉死为垂直侧边栏（B1）。缓存归一见 main.ts——此处默认值
    // 仍会被 localStorage 旧值压过，强制归一在 initPreferences 之后执行。
    layout: 'sidebar-nav',
    // 不显示浮动设置按钮(auto 会在右下角浮出并遮挡内容)
    preferencesButtonPosition: 'header',
  },
  logo: {
    source: LOGO_SRC,
    sourceDark: LOGO_SRC,
  },
  theme: {
    // AgentSDR 品牌蓝 blue-500 ≈#335CFF（白字 5.10:1，达 AA）。
    // hsl(228 100% 60%) 与 #335CFF 同值；侧栏激活项与 vben 派生控件一并蓝化。
    colorPrimary: '#335CFF',
    // 默认浅色；顶栏主题按钮仍可切到深色（两套 token 同时维护）。
    mode: 'light',
  },
  // 六页产品不需要多标签页与面包屑：去掉重复的标题层级，信息更聚焦
  tabbar: {
    enable: false,
  },
  breadcrumb: {
    enable: false,
  },
  // 顶栏只保留与产品相关的能力:搜索、主题、语言、全屏、刷新、通知、退出。
  // 去掉锁屏 / 时区 / 设置抽屉入口(后者在移动端会浮在内容之上)。
  // 注意：**不要在这里重写 widget.order** —— vben 的偏好合并用 defu，数组是拼接
  // 而不是覆盖，再写一遍会让每个控件渲染两次（2026-11-09 全站顶栏重复的根因）。
  // 默认 order 里已被下面布尔开关裁掉 preferences/timezone/fullscreen/lockScreenBtn，
  // 剩余可见序列（搜索→主题→语言→刷新→通知→退出）正是产品要的顺序。
  widget: {
    // pass3 C1：内置搜索由自定义命令面板替代（页面 + 动作 + ⌘K）。
    globalSearch: false,
    lockScreen: false,
    timezone: false,
    // 语言(中文/English)与主题(浅色/深色)都是一等能力:顶栏保留切换,
    // 登录/注册页另有独立的同功能控件(AuthTools)。
    languageToggle: true,
    themeToggle: true,
    fullscreen: false,
  },
  copyright: appCopyrightPreferences,
});

export const preferencesExtension =
  definePreferencesExtension<WebAntdPreferencesExtension>({
    tabLabel: 'preferences.antd.tabLabel',
    title: 'preferences.antd.title',
    fields: [
      {
        component: 'switch',
        defaultValue: true,
        key: 'enableFormFullscreen',
        label: 'preferences.antd.fields.enableFormFullscreen.label',
        tip: 'preferences.antd.fields.enableFormFullscreen.tip',
      },
      {
        component: 'select',
        defaultValue: 'single',
        key: 'tenantMode',
        label: 'preferences.antd.fields.tenantMode.label',
        options: [
          {
            label: 'preferences.antd.fields.tenantMode.options.single.label',
            value: 'single',
          },
          {
            label: 'preferences.antd.fields.tenantMode.options.multi.label',
            value: 'multi',
          },
        ],
      },
      {
        component: 'number',
        componentProps: {
          max: 200,
          min: 10,
          step: 10,
        },
        defaultValue: 20,
        key: 'defaultTableSize',
        label: 'preferences.antd.fields.defaultTableSize.label',
      },
      {
        component: 'input',
        defaultValue: '',
        key: 'reportTitle',
        label: 'preferences.antd.fields.reportTitle.label',
        placeholder: 'preferences.antd.fields.reportTitle.placeholder',
      },
    ],
  });

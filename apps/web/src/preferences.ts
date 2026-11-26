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
    // 关闭 Vben 偏好设置抽屉按钮，避免顶栏或右下角出现无关齿轮入口。
    enablePreferences: false,
    // pass3：布局钉死为垂直侧边栏（B1）。缓存归一见 main.ts——此处默认值
    // 仍会被 localStorage 旧值压过，强制归一在 initPreferences 之后执行。
    layout: 'sidebar-nav',
    preferencesButtonPosition: 'header',
  },
  logo: {
    // PR-UI1：侧栏顶区企业头由 SdrSidebar 统一渲染（48px 高与顶栏底线平齐），
    // 关闭 Vben 内置 logo 槽位，避免桌面重复渲染与移动端顶栏挤入旧 logo。
    enable: false,
    source: LOGO_SRC,
    sourceDark: LOGO_SRC,
  },
  sidebar: {
    collapsedButton: false,
    hidden: false,
    width: 220,
  },
  theme: {
    // AgentSDR 品牌蓝 blue-500 ≈#335CFF（白字 5.10:1，达 AA）。
    // hsl(228 100% 60%) 与 #335CFF 同值；侧栏激活项与 vben 派生控件一并蓝化。
    colorPrimary: '#335CFF',
    // 默认浅色；账号菜单内可随时切到深色（两套 token 同时维护）。
    mode: 'light',
  },
  // PR-UI1：彻底关闭顶部纯黑胶囊多标签栏，升级为 48px 极简面包屑顶栏。
  tabbar: {
    enable: false,
    height: 40,
    middleClickToClose: false,
    showMaximize: false,
    showIcon: false,
    styleType: 'card',
  },
  breadcrumb: {
    // 面包屑由 basic.vue 自定义 48px 极简响应式面包屑接管，关闭 Vben 内置版本。
    enable: false,
  },
  // PR-UI1：48px 极简白/暗画布顶栏（左侧移动汉堡 + 面包屑，右侧克制刷新小按钮）。
  header: {
    enable: true,
    height: 48,
    hidden: false,
  },
  // 顶栏精简：不渲染 Vben 默认部件（搜索/主题/语言/通知/退出均归入左侧栏与账号菜单）。
  // 注意：**不要在这里重写 widget.order** —— vben 的偏好合并用 defu，数组是拼接而不是覆盖。
  widget: {
    globalSearch: false,
    themeToggle: false,
    languageToggle: false,
    notification: false,
    lockScreen: false,
    logoutButtonPosition: 'none',
    refresh: false,
    sidebarToggle: false,
    timezone: false,
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

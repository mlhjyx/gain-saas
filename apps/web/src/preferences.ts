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
const LOGO_SRC = '/logo-gainos.svg';

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
    name: import.meta.env.VITE_APP_TITLE,
    defaultHomePath: '/workspace',
    // 不显示浮动设置按钮(auto 会在右下角浮出并遮挡内容)
    preferencesButtonPosition: 'header',
  },
  logo: {
    source: LOGO_SRC,
    sourceDark: LOGO_SRC,
  },
  theme: {
    colorPrimary: 'hsl(160 84% 39%)',
    // GainOS 采用浅色品牌设计(深色品牌面板在登录页内自持):
    // 整体 UI 固定浅色，避免跟随系统深色导致对比度失效。
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
  widget: {
    lockScreen: false,
    timezone: false,
    // 语言(中文/English)与主题(浅色/深色)都是一等能力:顶栏保留切换,
    // 登录/注册页另有独立的同功能控件(AuthTools)。
    languageToggle: true,
    themeToggle: true,
    fullscreen: false,
    order: [
      'globalSearch',
      'themeToggle',
      'languageToggle',
      'refresh',
      'notification',
      'logoutBtn',
    ],
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

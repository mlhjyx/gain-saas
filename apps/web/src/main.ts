import './styles/gainos.css';
import { initPreferences, updatePreferences } from '@vben/preferences';
import { unmountGlobalLoading } from '@vben/utils';

import { LOGO_SRC, overridesPreferences, preferencesExtension } from './preferences';

/**
 * pass3 A2：品牌字段缓存归一（方案 b：initPreferences 后强制 merge）。
 *
 * Vben 的偏好合并是「localStorage 缓存优先于代码默认」，老访客会把旧版
 * 绿色主题 / 顶栏布局一直带在身上。这里在缓存加载完成后无条件覆盖品牌
 * 相关字段并回写缓存（updatePreferences 自带 debounce 持久化）：
 * - theme.colorPrimary / builtinType：品牌蓝 #335CFF，驱动内联 --primary
 *   （nprogress 进度条、壳层派生色全部跟随）；
 * - logo.source/sourceDark：带版本号的 logo URL，击穿浏览器图片缓存；
 * - app.layout：垂直侧边栏，顶栏不再渲染菜单。
 * - widget.themeToggle/languageToggle/globalSearch：顶栏部件归一
 *   （主题/语言在侧栏品牌行，搜索在侧栏 ⌘K 框）。
 * 其余字段（theme.mode 明暗、sidebar.width/collapsed、语言等用户偏好）尊重缓存。
 */
const BRAND_PREFERENCES = {
  app: {
    enablePreferences: false,
    layout: 'sidebar-nav',
  },
  breadcrumb: { enable: false },
  // PR-UI1：48px 极简面包屑顶栏 + 关闭顶部多标签栏，确保新老访客刷新即刻生效。
  header: { enable: true, height: 48, hidden: false },
  logo: {
    enable: false,
    source: LOGO_SRC,
    sourceDark: LOGO_SRC,
  },
  // sidebar.hidden 归一：用户点过「内容最大化」会把缓存写成 hidden=true，
  // 不归一的话 SDR 覆盖层会永远浮在内容上。
  sidebar: { collapsedButton: false, hidden: false },
  tabbar: {
    enable: false,
    height: 40,
    middleClickToClose: false,
    showMaximize: false,
  },
  theme: { builtinType: 'default', colorPrimary: '#335CFF' },
  widget: {
    fullscreen: false,
    globalSearch: false,
    languageToggle: false,
    lockScreen: false,
    logoutButtonPosition: 'none',
    notification: false,
    refresh: false,
    sidebarToggle: false,
    themeToggle: false,
    timezone: false,
  },
} as const;

/**
 * 应用初始化完成之后再进行页面加载渲染
 */
async function initApplication() {
  // name用于指定项目唯一标识
  // 用于区分不同项目的偏好设置以及存储数据的key前缀以及其他一些需要隔离的数据
  const env = import.meta.env.PROD ? 'prod' : 'dev';
  const appVersion = import.meta.env.VITE_APP_VERSION;
  // pass3：namespace 必须跨环境确定。.env 是 gitignored 文件，CI 构建拿不到
  // VITE_APP_NAMESPACE 时会得到 `undefined-…`，导致偏好缓存 key 与生产不一致
  // （缓存归一回归测试因此误判）。回退到与 .env 相同的默认值。
  const appNamespace = import.meta.env.VITE_APP_NAMESPACE || 'vben-web-antd';
  const namespace = `${appNamespace}-${appVersion}-${env}`;

  // app偏好设置初始化
  await initPreferences({
    extension: preferencesExtension,
    namespace,
    overrides: overridesPreferences,
  });

  // 品牌字段归一：任何 localStorage 旧值（绿色主题 / header-nav）在此作废。
  updatePreferences(BRAND_PREFERENCES);

  // 启动应用并挂载
  // vue应用主要逻辑及视图
  const { bootstrap } = await import('./bootstrap');
  await bootstrap(namespace);

  // 移除并销毁loading
  unmountGlobalLoading();
}

initApplication();

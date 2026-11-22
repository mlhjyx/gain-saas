import type { InjectionKey } from 'vue';

/**
 * 设置页被「设置弹窗」嵌入渲染（而非整页路由渲染）时为 true。
 * 内嵌时页面不要读写 URL query：背景路由是用户当前页面，写 query 会污染它。
 * 独立访问 /settings/* 时注入缺省 false，行为与之前完全一致。
 */
export const SETTINGS_EMBEDDED_KEY: InjectionKey<boolean> = Symbol(
  'gainos:settings-embedded',
);

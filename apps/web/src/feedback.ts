/**
 * 全局反馈层（2026-11-23 pass6 / 方案 B）。
 *
 * antdv 4 的静态 `message / notification / Modal.confirm` 不消费 ConfigProvider
 * 主题（暗色下会变回默认色）。这里在 <App> 内初始化带上下文的实例，业务代码
 * 统一用 `feedback.*`；在 App 尚未挂载的极早阶段（路由守卫首跳）自动回退到
 * 静态 API，保证功能不丢。
 */
import type { MessageInstance } from 'ant-design-vue/es/message/interface';
import type { ModalStaticFunctions } from 'ant-design-vue/es/modal/confirm';
import type {
  ArgsProps as NotificationArgsProps,
  NotificationInstance,
} from 'ant-design-vue/es/notification/interface';

import {
  message as staticMessage,
  Modal as staticModal,
  notification as staticNotification,
} from 'ant-design-vue';

interface FeedbackContext {
  message: MessageInstance;
  modal: Omit<ModalStaticFunctions, 'warn'>;
  notification: NotificationInstance;
}

let context: FeedbackContext | null = null;

/** 由 components/feedback-init.vue 在 <App> 内调用。 */
export function initFeedback(next: FeedbackContext): void {
  context = next;
}

type ConfirmOptions = Parameters<ModalStaticFunctions['confirm']>[0];

/** 静态 notification 与 App.useApp() 的签名不同，统一成上下文实例的类型。 */
function notify(): NotificationInstance {
  return context?.notification ?? (staticNotification as unknown as NotificationInstance);
}

export const feedback = {
  message: {
    error: (content: string) => (context?.message ?? staticMessage).error(content),
    info: (content: string) => (context?.message ?? staticMessage).info(content),
    loading: (
      args: Parameters<MessageInstance['loading']>[0],
    ) => (context?.message ?? staticMessage).loading(args),
    open: (args: Parameters<MessageInstance['open']>[0]) =>
      (context?.message ?? staticMessage).open(args),
    success: (content: string) =>
      (context?.message ?? staticMessage).success(content),
    warning: (content: string) =>
      (context?.message ?? staticMessage).warning(content),
  },
  notification: {
    error: (args: NotificationArgsProps) => notify().error(args),
    info: (args: NotificationArgsProps) => notify().info(args),
    success: (args: NotificationArgsProps) => notify().success(args),
    warning: (args: NotificationArgsProps) => notify().warning(args),
  },
  /** 确认框：danger 变体统一 okType，保证暗色与品牌 token 生效。 */
  confirm: (options: ConfirmOptions) => {
    const dialog = context?.modal ?? staticModal;
    return dialog.confirm(options);
  },
};

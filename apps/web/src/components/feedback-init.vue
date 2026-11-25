<script lang="ts" setup>
/**
 * 反馈层初始化：必须渲染在 antd <App> 内部才能拿到带主题的
 * message / notification / modal（见 #/feedback）。
 */
import { App } from 'ant-design-vue';

import { initFeedback } from '#/feedback';

defineOptions({ name: 'FeedbackInit' });

const { message, modal, notification } = App.useApp();
initFeedback({ message, modal, notification });
</script>

<template>
  <span aria-hidden="true" style="display: none"></span>
</template>

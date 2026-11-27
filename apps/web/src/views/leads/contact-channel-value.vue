<script lang="ts" setup>
import { computed, onBeforeUnmount, ref } from 'vue';

import { Copy, ExternalLink, Mail, Phone } from '@vben/icons';
import { Button } from 'ant-design-vue';

import { feedback } from '#/feedback';
import { $t } from '#/locales';
import { copyText } from '#/utils/clipboard';

const props = defineProps<{
  authorizeOpen?: () => Promise<boolean>;
  copyable?: boolean;
  href?: string;
  sourceDate?: string;
  sourceLabel?: string;
  sourceUrl?: string;
  value: string;
}>();

const opening = ref(false);
let disposed = false;
onBeforeUnmount(() => { disposed = true; });

const action = computed(() => {
  if (props.href?.startsWith('mailto:')) return { icon: Mail, label: 'gainosContactOverview.compose', external: false };
  if (props.href?.startsWith('tel:')) return { icon: Phone, label: 'gainosContactOverview.call', external: false };
  return { icon: ExternalLink, label: 'gainosContactOverview.open', external: true };
});

async function copy(): Promise<void> {
  try {
    await copyText(props.value);
    feedback.message.success($t('gainos.leads.copied'));
  } catch {
    feedback.message.error($t('gainos.common.copyFailed'));
  }
}

async function openChecked(): Promise<void> {
  const { authorizeOpen, href } = props;
  if (!authorizeOpen || !href || opening.value) return;
  opening.value = true;
  try {
    const allowed = await authorizeOpen();
    if (allowed && !disposed && href === props.href) window.location.assign(href);
  } finally {
    opening.value = false;
  }
}
</script>

<template>
  <div class="grid min-w-0 gap-2">
    <span class="text-sm font-medium text-[var(--gs-fg)] [overflow-wrap:anywhere]">{{ value }}</span>
    <slot name="status" />
    <div v-if="sourceLabel || sourceUrl" class="flex flex-wrap items-baseline gap-x-2 text-xs text-[var(--gs-fg-muted)]">
      <span>{{ $t('gainos.contacts.source') }}</span>
      <a
        v-if="sourceUrl"
        :href="sourceUrl"
        class="text-[var(--gs-accent-fg)] underline [overflow-wrap:anywhere]"
        rel="noopener noreferrer"
        target="_blank"
      >{{ sourceLabel || sourceUrl }}</a>
      <span v-else>{{ sourceLabel }}</span>
      <span v-if="sourceDate">{{ sourceDate }}</span>
    </div>
    <div v-if="copyable || href || $slots.actions" class="flex flex-wrap items-center gap-2">
      <Button v-if="copyable" @click="copy">
        <template #icon><Copy aria-hidden="true" :size="14" /></template>
        {{ $t('gainosContactOverview.copy') }}
      </Button>
      <Button
        v-if="href && authorizeOpen"
        :loading="opening"
        @click="openChecked"
      >
        <template #icon><component :is="action.icon" aria-hidden="true" :size="14" /></template>
        {{ $t(action.label) }}
      </Button>
      <Button
        v-else-if="href"
        :href="href"
        :rel="action.external ? 'noopener noreferrer' : undefined"
        :target="action.external ? '_blank' : undefined"
      >
        <template #icon><component :is="action.icon" aria-hidden="true" :size="14" /></template>
        {{ $t(action.label) }}
      </Button>
      <slot name="actions" />
    </div>
  </div>
</template>

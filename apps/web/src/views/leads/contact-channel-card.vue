<script lang="ts" setup>
import { computed } from 'vue';

import { ExternalLink, Globe, Mail, MessageCircle, Phone } from '@vben/icons';

import GsCard from '#/components/gainos/ui/gs-card.vue';

const props = withDefaults(defineProps<{ heading?: 'h3' | 'h4'; kind: string; label: string }>(), { heading: 'h3' });

const brand = computed(() => {
  if (props.kind === 'linkedin') return 'in';
  if (props.kind === 'facebook') return 'f';
  if (props.kind === 'x') return 'X';
  return '';
});

const channelIcon = computed(() => {
  if (props.kind === 'email') return Mail;
  if (props.kind === 'phone') return Phone;
  if (props.kind === 'whatsapp') return MessageCircle;
  if (props.kind === 'form') return Globe;
  return ExternalLink;
});
</script>

<template>
  <section :aria-label="label" :data-channel="kind" class="channel-card" data-gs="contact-channel-card" tabindex="-1">
    <GsCard class="h-full" padding="16px">
      <component :is="heading" class="channel-card__title">
        <span aria-hidden="true" class="channel-card__icon">
          <span v-if="brand">{{ brand }}</span>
          <component v-else :is="channelIcon" :size="16" />
        </span>
        {{ label }}
      </component>
      <div class="grid min-w-0 gap-3 divide-y divide-[var(--gs-divider)] [&>*+*]:pt-3">
        <slot />
      </div>
    </GsCard>
  </section>
</template>

<style scoped>
.channel-card {
  min-width: 0;
  border-radius: 10px;
  scroll-margin-top: 68px;
}

.channel-card:focus-visible {
  outline: 2px solid var(--gs-accent-fg);
  outline-offset: 2px;
}

.channel-card__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  color: var(--gs-fg);
  font-size: 14px;
  font-weight: 600;
}

.channel-card__icon {
  display: grid;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  place-items: center;
  border-radius: 6px;
  background: var(--gs-accent-soft);
  color: var(--gs-accent-fg);
}
</style>

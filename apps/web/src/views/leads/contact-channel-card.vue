<script lang="ts" setup>
import { computed } from 'vue';

import { ExternalLink, Globe, Mail, MessageCircle, Phone } from '@vben/icons';

const props = defineProps<{ kind: string; label: string }>();

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
    <h4>
      <span class="channel-card__icon">
        <component :is="channelIcon" :size="15" aria-hidden="true" />
      </span>
      {{ label }}
    </h4>
    <div class="grid min-w-0 gap-2">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.channel-card {
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--gs-divider);
  border-radius: 8px;
  background: var(--gs-surface-2);
  scroll-margin-top: 68px;
}

.channel-card:focus-visible {
  outline: 2px solid var(--gs-accent-fg);
  outline-offset: 2px;
}

.channel-card h4 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 9px;
  color: var(--gs-fg);
  font-size: 13px;
  font-weight: 650;
}

.channel-card__icon {
  display: grid;
  width: 27px;
  height: 27px;
  flex-shrink: 0;
  place-items: center;
  border-radius: 6px;
  background: var(--gs-accent-soft);
  color: var(--gs-accent-fg);
}

.channel-card[data-channel='whatsapp'] .channel-card__icon,
.channel-card[data-channel='phone'] .channel-card__icon {
  background: var(--gs-success-bg);
  color: var(--gs-success);
}
</style>

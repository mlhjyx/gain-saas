<script lang="ts">
export interface CompanyChannelGroup {
  entries: Array<{ copyable: boolean; href: string; sourceLabel?: string; sourceUrl?: string; value: string }>;
  id: string;
  kind: string;
  label: string;
}
</script>

<script lang="ts" setup>
import { $t } from '#/locales';

import ContactChannelCard from './contact-channel-card.vue';
import ContactChannelValue from './contact-channel-value.vue';

defineProps<{ groups: CompanyChannelGroup[]; legalNote?: string; restricted: boolean }>();
</script>

<template>
  <section class="grid min-w-0 gap-3" data-gs="people-public-channels">
    <h2 class="m-0 text-lg font-semibold">{{ $t('gainosContactOverview.publicChannels') }}</h2>
    <div v-if="groups.length" class="grid grid-cols-[repeat(auto-fit,minmax(min(250px,100%),1fr))] gap-3">
      <ContactChannelCard
        v-for="group in groups"
        :id="group.id"
        :key="group.id"
        :kind="group.kind"
        :label="group.label"
      >
        <ContactChannelValue
          v-for="(entry, index) in group.entries"
          :key="index"
          v-bind="entry"
        />
      </ContactChannelCard>
    </div>
    <p v-else class="m-0 text-sm text-[var(--gs-fg-muted)]">
      {{ $t(restricted ? 'gainosContactOverview.restricted' : 'gainosB4.leadsDetail.publicChannelsEmpty') }}
    </p>
    <p v-if="legalNote && !restricted" class="m-0 text-xs text-[var(--gs-fg-muted)]">
      {{ legalNote }}
    </p>
  </section>
</template>

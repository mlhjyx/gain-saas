<script lang="ts" setup>
import type { LeadPackage } from '#/api/gainos';

import { computed, ref, useId } from 'vue';

import { formatDate } from '@gain-saas/shared';
import { ChevronDown } from '@vben/icons';
import { Button } from 'ant-design-vue';

import { $t } from '#/locales';
import { regionName } from '#/utils/region-name';

import { safePublicUrl } from './public-contact-paths';

const props = defineProps<{ affiliated?: boolean; lead: LeadPackage }>();
const company = computed(() => props.lead.company);
const overview = computed(() => props.lead.company_overview);
const website = computed(() => safePublicUrl(overview.value?.official_website));
const websiteHost = computed(() => website.value ? new URL(website.value).hostname : '');
const location = computed(() => {
  const country = company.value.country?.trim();
  const city = company.value.city?.trim();
  return [
    country && regionName(country),
    city && $t('gainosContactOverview.registeredCity', { city }),
  ].filter(Boolean).join(' · ');
});

const mainBusiness = computed(() => overview.value?.main_business ?? []);
const sources = computed(() => (overview.value?.sources ?? []).flatMap((source) => {
  const url = safePublicUrl(source.source_url);
  return url ? [{ date: formatDate(source.fetched_at), field: source.field, url }] : [];
}));
const detailsId = useId();
const detailsOpen = ref(false);
</script>

<template>
  <section class="min-w-0 space-y-2 [overflow-wrap:anywhere]" data-gs="lead-contact-company">
    <header class="flex flex-wrap items-center justify-between gap-x-2">
      <span class="text-xs font-medium text-[var(--gs-fg-muted)]">
        {{ $t(affiliated ? 'gainosContactOverview.affiliatedCompany' : 'gainosContactOverview.company') }}
      </span>
      <Button
        v-if="sources.length || mainBusiness.length > 3"
        :aria-controls="detailsId"
        :aria-expanded="detailsOpen"
        size="small"
        type="link"
        @click="detailsOpen = !detailsOpen"
      >
        <template #icon><ChevronDown aria-hidden="true" :size="14" /></template>
        {{ $t('gainosContactOverview.sources') }}
      </Button>
    </header>
    <h2 class="m-0 text-lg font-semibold leading-snug">
      {{ company.name || $t('gainos.leads.unknownCompany') }}
    </h2>
    <p class="m-0 text-sm leading-relaxed text-[var(--gs-fg-muted)]">
      {{ overview?.description || $t('gainosContactOverview.noDescription') }}
    </p>
    <dl v-if="location || mainBusiness.length || website || company.domain" class="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
      <template v-if="location">
        <dt class="text-[var(--gs-fg-muted)]">{{ $t('gainosContactOverview.location') }}</dt>
        <dd class="m-0">{{ location }}</dd>
      </template>
      <template v-if="mainBusiness.length">
        <dt class="text-[var(--gs-fg-muted)]">{{ $t('gainosContactOverview.mainBusiness') }}</dt>
        <dd class="m-0">{{ mainBusiness.slice(0, 3).join($t('gainosContactOverview.businessSeparator')) }}</dd>
      </template>
      <template v-if="website || company.domain">
        <dt class="text-[var(--gs-fg-muted)]">
          {{ $t(website ? 'gainosContactOverview.website' : 'gainosContactOverview.domain') }}
        </dt>
        <dd class="m-0">
          <a v-if="website" :href="website" class="font-medium text-[var(--gs-accent-fg)] hover:underline" rel="noopener noreferrer" target="_blank">
            {{ websiteHost }}
          </a>
          <span v-else>{{ company.domain }}</span>
        </dd>
      </template>
    </dl>
    <div :id="detailsId" v-show="detailsOpen" class="space-y-3 border-t border-[var(--gs-divider)] pt-3">
      <div v-if="mainBusiness.length > 3">
        <h3 class="m-0 text-sm font-semibold">{{ $t('gainosContactOverview.mainBusiness') }}</h3>
        <ul class="mb-0 mt-1 space-y-1 pl-5 text-sm">
          <li v-for="item in mainBusiness" :key="item">{{ item }}</li>
        </ul>
      </div>
      <ul v-if="sources.length" class="m-0 grid list-none gap-2 p-0 text-xs">
        <li v-for="source in sources" :key="source.field + '|' + source.url">
          <div class="flex flex-wrap gap-x-2 text-[var(--gs-fg-muted)]">
            <span>{{ $t('gainosContactOverview.sourceFields.' + source.field) }}</span>
            <span v-if="source.date">{{ source.date }}</span>
          </div>
          <a :href="source.url" class="text-[var(--gs-accent-fg)] underline" rel="noopener noreferrer" target="_blank">
            {{ source.url }}
          </a>
        </li>
      </ul>
    </div>
  </section>
</template>

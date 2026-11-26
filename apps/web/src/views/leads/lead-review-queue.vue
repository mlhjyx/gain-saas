<script lang="ts" setup>
import type { Lead } from '#/api/gainos';

import { Checkbox } from 'ant-design-vue';

import { $t } from '#/locales';

import { displayLeadScore } from './judge';
defineProps<{
  activeId: null | string;
  allSelected: boolean;
  someSelected: boolean;
  leads: Lead[];
  selectedIds: Set<string>;
}>();

const emit = defineEmits<{
  preview: [lead: Lead];
  select: [id: string, selected: boolean];
  selectAll: [selected: boolean];
}>();
</script>

<template>
  <section
    :aria-label="$t('gainosUi2.leads.reviewCandidates')"
    class="review-queue"
    data-gs="lead-review-queue"
  >
    <header class="review-queue__header">
      <h2>
        {{ $t('gainosUi2.leads.reviewCandidates') }}
        <span>{{ leads.length }}</span>
      </h2>
      <Checkbox
        :aria-label="$t('gainosUi2.leads.selectAllAria')"
        :checked="allSelected"
        :indeterminate="someSelected"
        data-gs="leads-select-all"
        @change="(event) => emit('selectAll', Boolean(event.target?.checked))"
      />
    </header>
    <ul class="review-queue__list">
      <li
        v-for="lead in leads"
        :key="lead.id"
        :class="{ 'is-current': lead.id === activeId }"
        class="review-queue__row"
        data-gs="lead-review-row"
      >
        <Checkbox
          :aria-label="$t('gainosB4.leadsBulk.selectLeadAria', { name: lead.company?.name || $t('gainos.leads.unknownCompany') })"
          :checked="selectedIds.has(lead.id)"
          data-gs="lead-select-checkbox"
          @change="(event) => emit('select', lead.id, Boolean(event.target?.checked))"
        />
        <button
          :aria-pressed="lead.id === activeId"
          class="review-queue__candidate"
          type="button"
          @click="emit('preview', lead)"
        >
          <span class="review-queue__company">
            <strong>{{ lead.company?.name || $t('gainos.leads.unknownCompany') }}</strong>
            <span v-if="lead.company?.country || lead.company?.domain">
              {{ [lead.company?.country, lead.company?.domain].filter(Boolean).join(' · ') }}
            </span>
          </span>
          <span class="review-queue__score">{{ displayLeadScore(lead.totalScore) ?? '—' }}</span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.review-queue {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--gs-divider);
  border-radius: 9px;
  background: var(--gs-surface-1, var(--gs-bg));
}

.review-queue__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--gs-surface-2);
}

.review-queue__header h2 {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 0;
  font-size: 13px;
  font-weight: 650;
}

.review-queue__header h2 span {
  color: var(--gs-fg-muted);
  font-variant-numeric: tabular-nums;
}

.review-queue__list {
  max-height: 570px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.review-queue__row {
  display: grid;
  min-height: 51px;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 0 9px;
  border-top: 1px solid var(--gs-divider);
  border-inline-start: 3px solid transparent;
}

.review-queue__row.is-current {
  border-inline-start-color: var(--gs-accent-fg);
  background: var(--gs-accent-soft);
}

.review-queue__candidate {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 0;
  border: 0;
  background: transparent;
  color: var(--gs-fg);
  text-align: start;
  cursor: pointer;
}

.review-queue__candidate:focus-visible {
  outline: 2px solid var(--gs-accent-fg);
  outline-offset: 2px;
}

.review-queue__company {
  min-width: 0;
}

.review-queue__company strong,
.review-queue__company > span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.review-queue__company strong {
  font-size: 13px;
  font-weight: 650;
}

.review-queue__company > span {
  color: var(--gs-fg-muted);
  font-size: 11px;
}

.review-queue__score {
  flex-shrink: 0;
  color: var(--gs-accent-fg);
  font-size: 15px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
</style>

<script setup lang="ts">
import { formatDateTime } from '@gain-saas/shared';
import type { RevisionPage } from "#/api/market-candidates";
import { $t } from "#/locales";
defineProps<{ rows: RevisionPage["revisions"]; hasMore: boolean; busy: boolean }>();
defineEmits<{ select: [revision: number]; more: []; current: [] }>();
</script>
<template>
  <section class="mc-history" :aria-label="$t('gainos.marketCandidates.history')">
    <h3>{{ $t("gainos.marketCandidates.history") }}</h3>
    <p>{{ $t("gainos.marketCandidates.historyHint") }}</p>
    <button type="button" data-testid="mc-current" @click="$emit('current')">
      {{ $t("gainos.marketCandidates.backToCurrent") }}
    </button>
    <p v-if="rows.length === 0 && !busy">{{ $t("gainos.marketCandidates.historyEmpty") }}</p>
    <ul>
      <li v-for="row in rows" :key="row.revision">
        <button
          type="button"
          :data-testid="`mc-revision-${row.revision}`"
          :disabled="busy"
          @click="$emit('select', row.revision)"
        >
          {{ $t("gainos.marketCandidates.revisionLabel", { revision: row.revision }) }} ·
          {{ formatDateTime(row.createdAt) }}
        </button>
      </li>
    </ul>
    <button
      v-if="hasMore"
      type="button"
      data-testid="mc-history-more"
      :disabled="busy"
      @click="$emit('more')"
    >
      {{ $t("gainos.marketCandidates.loadMoreHistory") }}
    </button>
  </section>
</template>

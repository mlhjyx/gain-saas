<script setup lang="ts">
import { computed } from "vue";
import type { Candidate } from "#/api/market-candidates";
import { $t } from "#/locales";
const props = defineProps<{
  candidate: Candidate;
  readOnly: boolean;
  reviewDenied: boolean;
  selected: boolean;
}>();
const emit = defineEmits<{ details: [trigger: HTMLElement]; feedback: [trigger: HTMLElement] }>();
const conditions = computed(
  () =>
    props.candidate.corrections.entryConditions ??
    props.candidate.proposal.entryConditions.map((row) => row.text),
);
function details(event: MouseEvent) {
  if (event.currentTarget instanceof HTMLElement) emit("details", event.currentTarget);
}
function feedback(event: MouseEvent) {
  if (event.currentTarget instanceof HTMLElement) emit("feedback", event.currentTarget);
}
const feedbackLabels = {
  PENDING: "feedbackPending",
  CONFIRMED: "feedbackConfirmed",
  CORRECTED: "feedbackCorrected",
  PENDING_EVIDENCE: "feedbackPendingEvidence",
  REJECTED: "feedbackRejected",
};
</script>
<template>
  <article data-testid="mc-card" class="mc-card" :class="{ 'mc-card--selected': selected }">
    <header>
      <span class="mc-pill">{{
        $t(`gainos.marketCandidates.${feedbackLabels[candidate.feedback]}`)
      }}</span
      ><span v-if="candidate.needsReassessment">{{
        $t("gainos.marketCandidates.reassessment")
      }}</span>
    </header>
    <h3>
      {{
        candidate.corrections.supplyDescription ?? candidate.proposal.supplyOrCapability.description
      }}
    </h3>
    <dl>
      <div>
        <dt>{{ $t("gainos.marketCandidates.application") }}</dt>
        <dd>{{ candidate.corrections.application ?? candidate.proposal.application.text }}</dd>
      </div>
      <div>
        <dt>{{ $t("gainos.marketCandidates.buyerOrgCountry") }}</dt>
        <dd>
          {{
            candidate.corrections.buyerOrganizationCountry !== undefined
              ? (candidate.corrections.buyerOrganizationCountry ??
                $t("gainos.marketCandidates.unknown"))
              : (candidate.proposal.buyerOrganizationCountry ??
                $t("gainos.marketCandidates.unknown"))
          }}
        </dd>
      </div>
      <div>
        <dt>{{ $t("gainos.marketCandidates.projectCountry") }}</dt>
        <dd>
          {{
            candidate.corrections.projectCountry !== undefined
              ? (candidate.corrections.projectCountry ?? $t("gainos.marketCandidates.unknown"))
              : (candidate.proposal.projectCountry ?? $t("gainos.marketCandidates.unknown"))
          }}
        </dd>
      </div>
      <div>
        <dt>{{ $t("gainos.marketCandidates.orgRole") }}</dt>
        <dd>
          {{ candidate.corrections.organizationRole ?? candidate.proposal.organizationRole.text }}
        </dd>
      </div>
    </dl>
    <p class="mc-conclusion">
      {{
        $t(`gainos.marketCandidates.recommendations.${candidate.proposal.recommendation.status}`)
      }}
      · {{ candidate.proposal.recommendation.reason }}
    </p>
    <p v-for="(condition, i) in conditions" :key="i">
      {{ $t("gainos.marketCandidates.conditions") }}: {{ condition }}
    </p>
    <footer>
      <button type="button" data-testid="mc-details" :aria-pressed="selected" @click="details">
        {{ $t("gainos.marketCandidates.details") }}</button
      ><button
        v-if="!readOnly"
        type="button"
        data-testid="mc-feedback"
        :disabled="reviewDenied"
        @click="feedback"
      >
        {{ $t("gainos.marketCandidates.giveFeedback") }}</button
      ><span v-if="readOnly">{{ $t("gainos.marketCandidates.readOnly") }}</span>
    </footer>
  </article>
</template>

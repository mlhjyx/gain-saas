<script setup lang="ts">
import { computed } from "vue";
import type { Candidate, Revision } from "#/api/market-candidates";
import { $t } from "#/locales";
const props = defineProps<{ candidate: Candidate; revision: Revision }>();
defineEmits<{ close: [] }>();
const labels = {
  SELLER_ASSERTION: "sellerAssertion",
  REVIEWED_SOURCE_FACT: "reviewedFact",
  INFERENCE: "inference",
  CONFLICT: "conflict",
  UNKNOWN: "unknownKnowledge",
};
const groups = computed(() => [
  { name: "application", rows: [props.candidate.proposal.application] },
  { name: "orgRole", rows: [props.candidate.proposal.organizationRole] },
  { name: "correctionFit", rows: [props.candidate.proposal.fitExplanation] },
  { name: "entryConditions", rows: props.candidate.proposal.entryConditions },
  { name: "support", rows: props.candidate.proposal.support },
  { name: "counterEvidence", rows: props.candidate.proposal.counterEvidence },
  { name: "gaps", rows: props.candidate.proposal.gaps },
]);
const availabilityLabels = {
  CURRENT: "basisCurrent",
  CHANGED: "basisChanged",
  UNAVAILABLE: "basisUnavailable",
  UNKNOWN: "basisUnknown",
};
</script>
<template>
  <section data-testid="mc-detail" class="mc-detail" tabindex="-1">
    <header>
      <h3>{{ $t("gainos.marketCandidates.details") }}</h3>
      <button type="button" @click="$emit('close')">
        {{ $t("gainos.marketCandidates.closeDetail") }}
      </button>
    </header>
    <p>{{ $t("gainos.marketCandidates.originalProposal") }}</p>
    <p>{{ candidate.proposal.supplyOrCapability.description }}</p>
    <dl data-testid="mc-original-countries">
      <div>
        <dt>{{ $t("gainos.marketCandidates.buyerOrgCountry") }}</dt>
        <dd data-testid="mc-original-buyer-country">
          {{ candidate.proposal.buyerOrganizationCountry ?? $t("gainos.marketCandidates.unknown") }}
        </dd>
      </div>
      <div>
        <dt>{{ $t("gainos.marketCandidates.projectCountry") }}</dt>
        <dd data-testid="mc-original-project-country">
          {{ candidate.proposal.projectCountry ?? $t("gainos.marketCandidates.unknown") }}
        </dd>
      </div>
    </dl>
    <section v-for="group in groups" :key="group.name">
      <h4>{{ $t(`gainos.marketCandidates.${group.name}`) }}</h4>
      <p v-if="group.rows.length === 0">{{ $t("gainos.marketCandidates.noBasis") }}</p>
      <article v-for="(row, i) in group.rows" :key="i" class="mc-statement">
        <span class="mc-pill">{{
          $t(`gainos.marketCandidates.${labels[row.knowledgeState]}`)
        }}</span>
        <p>{{ row.text }}</p>
        <p>
          {{ $t("gainos.marketCandidates.impact") }}:
          {{ row.impact || $t("gainos.marketCandidates.unknown") }}
        </p>
        <details>
          <summary>{{ $t("gainos.marketCandidates.basisKey") }}</summary>
          <small>{{ row.basisKeys.join(" · ") || $t("gainos.marketCandidates.noBasis") }}</small>
        </details>
      </article>
    </section>
    <section>
      <h4>{{ $t("gainos.marketCandidates.nextVerification") }}</h4>
      <ul>
        <li v-for="(row, i) in candidate.proposal.nextVerification" :key="i">{{ row }}</li>
      </ul>
    </section>
    <section v-if="Object.keys(candidate.corrections).length">
      <h4>{{ $t("gainos.marketCandidates.correctionOverlay") }}</h4>
      <dl>
        <div v-for="(value, key) in candidate.corrections" :key="key">
          <dt>{{ $t(`gainos.marketCandidates.correctionFields.${key}`) }}</dt>
          <dd>
            {{
              Array.isArray(value)
                ? value.join(" · ") || $t("gainos.marketCandidates.cleared")
                : (value ?? $t("gainos.marketCandidates.unknown"))
            }}
          </dd>
        </div>
      </dl>
    </section>
    <section>
      <h4>{{ $t("gainos.marketCandidates.basis") }}</h4>
      <p>
        {{ $t("gainos.marketCandidates.basisVersion") }}:
        {{ revision.document.basisSnapshot.company.version }}
      </p>
      <article
        v-for="source in revision.document.basisSnapshot.sources"
        :key="source.key"
        class="mc-source"
      >
        <strong>{{ $t(`gainos.marketCandidates.sourceKinds.${source.kind}`) }}</strong>
        <details>
          <summary>{{ $t("gainos.marketCandidates.basisKey") }}</summary>
          <p>{{ source.key }}</p>
        </details>
        <p>
          {{ $t("gainos.marketCandidates.version") }}:
          {{ source.version ?? $t("gainos.marketCandidates.unknown") }} ·
          {{ $t("gainos.marketCandidates.sourceDate") }}:
          {{ source.sourceDate ?? $t("gainos.marketCandidates.unknown") }}
        </p>
        <p>
          {{
            $t(
              `gainos.marketCandidates.${availabilityLabels[revision.basisAvailability.find((row) => row.key === source.key)?.status ?? "UNKNOWN"]}`,
            )
          }}
        </p>
        <p>
          {{ $t("gainos.marketCandidates.sourcePosition") }}:
          {{
            source.position
              ? [
                  source.position.seq,
                  source.position.page,
                  source.position.section,
                  source.position.quoteStart,
                  source.position.quoteEnd,
                ]
                  .map((v) => v ?? "—")
                  .join(" / ")
              : $t("gainos.marketCandidates.unknown")
          }}
        </p>
      </article>
      <p v-if="!revision.document.basisSnapshot.sources.length">
        {{ $t("gainos.marketCandidates.noBasis") }}
      </p>
    </section>
  </section>
</template>

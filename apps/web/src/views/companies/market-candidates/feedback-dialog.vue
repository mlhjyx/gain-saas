<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import type { Candidate, Correction, FeedbackInput } from "#/api/market-candidates";
import type { UserFeedbackDraft } from "./use-market-candidates";
import { $t } from "#/locales";
const props = defineProps<{
  candidate: Candidate;
  revision: number;
  busy: boolean;
  error: string;
  errorWhy?: string;
  errorNext?: string;
  frozen: boolean;
  denied: boolean;
  knownRefusal: boolean;
  unknownOutcome: boolean;
  current: Candidate | null;
  currentRevision: number;
  checked: boolean;
  checking: boolean;
  initialDraft: UserFeedbackDraft | null;
}>();
const emit = defineEmits<{
  submit: [body: FeedbackInput];
  cancel: [];
  dirty: [value: boolean];
  draft: [value: UserFeedbackDraft];
  check: [];
  redecide: [];
}>();
const root = ref<HTMLElement | null>(null),
  validation = ref("");
const fields = [
  "supplyDescription",
  "application",
  "organizationRole",
  "fitExplanation",
  "buyerOrganizationCountry",
  "projectCountry",
  "entryConditions",
  "gaps",
  "nextVerification",
] as const;
type Field = (typeof fields)[number];
const touched = new Set<Field>();
function projection(c: Candidate) {
  return {
    supplyDescription: c.corrections.supplyDescription ?? c.proposal.supplyOrCapability.description,
    application: c.corrections.application ?? c.proposal.application.text,
    organizationRole: c.corrections.organizationRole ?? c.proposal.organizationRole.text,
    fitExplanation: c.corrections.fitExplanation ?? c.proposal.fitExplanation.text,
    buyerOrganizationCountry:
      c.corrections.buyerOrganizationCountry !== undefined
        ? c.corrections.buyerOrganizationCountry
        : c.proposal.buyerOrganizationCountry,
    projectCountry:
      c.corrections.projectCountry !== undefined
        ? c.corrections.projectCountry
        : c.proposal.projectCountry,
    entryConditions: c.corrections.entryConditions ?? c.proposal.entryConditions.map((r) => r.text),
    gaps: c.corrections.gaps ?? c.proposal.gaps.map((r) => r.text),
    nextVerification: c.corrections.nextVerification ?? c.proposal.nextVerification,
  };
}
const base = computed(() => projection(props.candidate));
const currentProjection = computed(() => (props.current ? projection(props.current) : null));
const stringValue = (v: unknown) =>
  Array.isArray(v) ? v.join("\n") : typeof v === "string" ? v : "";
const initial = base.value;
const form = reactive({
  action: props.initialDraft?.action ?? ("CONFIRM" as FeedbackInput["action"]),
  reason: props.initialDraft?.reason ?? "",
  supplyDescription: initial.supplyDescription,
  application: initial.application,
  organizationRole: initial.organizationRole,
  fitExplanation: initial.fitExplanation,
  buyerOrganizationCountry: initial.buyerOrganizationCountry ?? "",
  projectCountry: initial.projectCountry ?? "",
  entryConditions: initial.entryConditions.join("\n"),
  gaps: initial.gaps.join("\n"),
  nextVerification: initial.nextVerification.join("\n"),
});
for (const key of fields) {
  const value = props.initialDraft?.correction[key];
  if (value !== undefined) {
    touched.add(key);
    form[key] = stringValue(value);
  }
}
watch(
  () => props.candidate,
  () => {
    for (const key of fields) if (!touched.has(key)) form[key] = stringValue(base.value[key]);
  },
);
function userDraft() {
  const correction: Correction = {};
  for (const key of [
    "supplyDescription",
    "application",
    "organizationRole",
    "fitExplanation",
  ] as const)
    if (touched.has(key)) correction[key] = form[key];
  for (const key of ["buyerOrganizationCountry", "projectCountry"] as const)
    if (touched.has(key)) correction[key] = form[key] || null;
  for (const key of ["entryConditions", "gaps", "nextVerification"] as const)
    if (touched.has(key)) correction[key] = form[key].split("\n");
  return { action: form.action, reason: form.reason, correction };
}
function draftChanged() {
  emit("dirty", true);
  emit("draft", userDraft());
}
function fieldInput(key: Field, event: Event) {
  form[key] = (event.target as HTMLTextAreaElement).value;
  touched.add(key);
  draftChanged();
}
function reasonInput(event: Event) {
  form.reason = (event.target as HTMLTextAreaElement).value;
  draftChanged();
}
function actionInput(event: Event) {
  const v = (event.target as HTMLSelectElement).value;
  if (["CONFIRM", "CORRECT", "KEEP_PENDING", "REJECT"].includes(v))
    form.action = v as FeedbackInput["action"];
  draftChanged();
}
const correction = computed<Correction>(() => {
  const result: Correction = {};
  for (const key of [
    "supplyDescription",
    "application",
    "organizationRole",
    "fitExplanation",
  ] as const) {
    const v = form[key].trim();
    if (touched.has(key) && v !== base.value[key]) result[key] = v;
  }
  for (const key of ["buyerOrganizationCountry", "projectCountry"] as const) {
    const v = form[key].trim().toUpperCase() || null;
    if (touched.has(key) && v !== base.value[key]) result[key] = v;
  }
  for (const key of ["entryConditions", "gaps", "nextVerification"] as const) {
    const v = form[key]
      .split("\n")
      .map((v) => v.trim())
      .filter(Boolean);
    if (touched.has(key) && JSON.stringify(v) !== JSON.stringify(base.value[key])) result[key] = v;
  }
  return result;
});
function submit() {
  validation.value = "";
  if (props.knownRefusal && props.frozen) return;
  if (form.action === "CORRECT" && !Object.keys(correction.value).length) {
    validation.value = $t("gainos.marketCandidates.emptyCorrection");
    return;
  }
  if (
    form.action === "CORRECT" &&
    [correction.value.buyerOrganizationCountry, correction.value.projectCountry].some(
      (v) => v !== undefined && v !== null && !/^[A-Z]{2}$/.test(v),
    )
  ) {
    validation.value = $t("gainos.marketCandidates.countryValidation");
    return;
  }
  if (Object.values(correction.value).some((v) => Array.isArray(v) && v.length > 200)) {
    validation.value = $t("gainos.marketCandidates.correctionLimit");
    return;
  }
  emit("draft", userDraft());
  emit("submit", {
    expectedRevision: props.revision,
    action: form.action,
    ...(form.reason.trim() ? { reason: form.reason } : {}),
    ...(form.action === "CORRECT" ? { correction: correction.value } : {}),
  });
}
function keydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.stopPropagation();
    event.preventDefault();
    if (!props.busy) emit("cancel");
  }
  if (event.key === "Tab") {
    const nodes = [
      ...(root.value?.querySelectorAll<HTMLElement>(
        "button:not([disabled]),textarea:not([disabled]),select:not([disabled]),input:not([disabled])",
      ) ?? []),
    ].filter((e) => e.getClientRects().length);
    if (!nodes.length) {
      event.preventDefault();
      root.value?.focus();
      return;
    }
    const index = nodes.findIndex((e) => e === document.activeElement);
    if (event.shiftKey && index <= 0) {
      event.preventDefault();
      nodes[nodes.length - 1]?.focus();
    } else if (!event.shiftKey && (index < 0 || index === nodes.length - 1)) {
      event.preventDefault();
      nodes[0]?.focus();
    }
  }
}
watch(
  () => props.busy,
  async () => {
    await nextTick();
    if (root.value && !root.value.contains(document.activeElement)) root.value.focus();
  },
);
onMounted(async () => {
  await nextTick();
  root.value?.querySelector<HTMLElement>("select:not([disabled]),button:not([disabled])")?.focus();
});
</script>
<template>
  <div class="mc-feedback-mask" @keydown="keydown">
    <section
      ref="root"
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      :aria-label="$t('gainos.marketCandidates.feedbackTitle')"
      class="mc-feedback-dialog"
      data-testid="mc-feedback-dialog"
    >
      <h3>
        {{ $t("gainos.marketCandidates.feedbackTitle") }} ·
        {{ $t("gainos.marketCandidates.revisionLabel", { revision }) }}
      </h3>
      <p>{{ $t("gainos.marketCandidates.confirmHint") }}</p>
      <form @submit.prevent="submit">
        <label
          >{{ $t("gainos.marketCandidates.giveFeedback")
          }}<select
            :value="form.action"
            data-testid="mc-feedback-action"
            :disabled="busy || frozen"
            @change="actionInput"
          >
            <option value="CONFIRM">{{ $t("gainos.marketCandidates.actionConfirm") }}</option>
            <option value="CORRECT">{{ $t("gainos.marketCandidates.actionCorrect") }}</option>
            <option value="KEEP_PENDING">
              {{ $t("gainos.marketCandidates.actionKeepPending") }}
            </option>
            <option value="REJECT">{{ $t("gainos.marketCandidates.actionReject") }}</option>
          </select></label
        >
        <p v-if="form.action === 'CORRECT'">{{ $t("gainos.marketCandidates.correctHint") }}</p>
        <p v-if="form.action === 'REJECT'">{{ $t("gainos.marketCandidates.rejectHint") }}</p>
        <div v-if="form.action === 'CORRECT'" class="mc-corrections">
          <label v-for="field in fields" :key="field"
            >{{ $t(`gainos.marketCandidates.correctionFields.${field}`)
            }}<textarea
              :value="form[field]"
              :data-testid="`mc-correction-${field}`"
              :disabled="busy || frozen"
              :rows="field === 'buyerOrganizationCountry' || field === 'projectCountry' ? 1 : 2"
              :maxlength="
                field === 'entryConditions' || field === 'gaps' || field === 'nextVerification'
                  ? 40000
                  : 2000
              "
              :aria-describedby="validation || error ? 'mc-feedback-problem' : undefined"
              @input="fieldInput(field, $event)"
            />
          </label>
        </div>
        <label
          >{{ $t("gainos.marketCandidates.reasonLabel")
          }}<textarea
            :value="form.reason"
            data-testid="mc-reason"
            :disabled="busy || frozen"
            rows="3"
            maxlength="2000"
            :placeholder="$t('gainos.marketCandidates.reasonPlaceholder')"
            @input="reasonInput"
          />
        </label>
        <div id="mc-feedback-problem">
          <p v-if="validation" role="alert" data-testid="mc-feedback-validation">
            {{ validation }}
          </p>
          <section v-if="error" class="mc-error" role="alert" data-testid="mc-feedback-error">
            <p>{{ error }}</p>
            <p v-if="errorWhy" data-testid="mc-feedback-error-why">{{ errorWhy }}</p>
            <p v-if="errorNext" data-testid="mc-feedback-error-next">{{ errorNext }}</p>
          </section>
        </div>
        <p v-if="unknownOutcome && frozen">{{ $t("gainos.marketCandidates.feedbackUnknown") }}</p>
        <section v-if="knownRefusal" class="mc-generation">
          <p>{{ $t("gainos.marketCandidates.knownRefusalHint") }}</p>
          <button
            type="button"
            data-testid="mc-feedback-check"
            :disabled="checking || busy"
            @click="emit('check')"
          >
            {{ $t("gainos.marketCandidates.checkCurrent") }}
          </button>
          <div v-if="currentProjection" data-testid="mc-feedback-current">
            <h4>
              {{ $t("gainos.marketCandidates.revisionLabel", { revision: currentRevision }) }}
            </h4>
            <dl>
              <div v-for="field in fields" :key="field">
                <dt>{{ $t(`gainos.marketCandidates.correctionFields.${field}`) }}</dt>
                <dd>
                  {{
                    stringValue(currentProjection[field]) || $t("gainos.marketCandidates.unknown")
                  }}
                </dd>
              </div>
            </dl>
          </div>
          <p v-else>{{ $t("gainos.marketCandidates.cannotCompare") }}</p>
          <button
            type="button"
            data-testid="mc-feedback-redecide"
            :disabled="!checked || checking || busy || denied"
            @click="emit('redecide')"
          >
            {{ $t("gainos.marketCandidates.redecide") }}
          </button>
        </section>
        <footer>
          <button
            type="button"
            data-testid="mc-feedback-cancel"
            :disabled="busy"
            @click="emit('cancel')"
          >
            {{ $t("gainos.marketCandidates.cancel") }}</button
          ><button
            type="submit"
            class="mc-primary"
            data-testid="mc-feedback-save"
            :disabled="busy || denied || (knownRefusal && frozen)"
          >
            {{
              busy
                ? $t("gainos.marketCandidates.busy")
                : frozen
                  ? $t("gainos.marketCandidates.retry")
                  : $t("gainos.marketCandidates.save")
            }}
          </button>
        </footer>
      </form>
    </section>
  </div>
</template>

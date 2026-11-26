<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, watch } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { feedback } from "#/feedback";
import { $t } from "#/locales";
import { formatDateTime } from '@gain-saas/shared';
import CandidateCard from "./candidate-card.vue";
import CandidateDetail from "./candidate-detail.vue";
import FeedbackDialog from "./feedback-dialog.vue";
import RevisionHistory from "./revision-history.vue";
import { useMarketCandidates } from "./use-market-candidates";
const props = defineProps<{ companyId: string; companyName: string; context: string; hidden?: boolean }>();
const emit = defineEmits<{
  close: [];
  recover: [{ companyId: string; destination: 'facts' | 'documents' }];
}>();
const state = useMarketCandidates(toRef(props, "companyId"), toRef(props, "context"));
const {
  ownDraft,
  feedbackFailure,
  feedbackCurrent,
  feedbackCurrentRevision,
  feedbackChecked,
  feedbackChecking,
  canResumeDraft,
  receipt,
  selected,
  generation,
  loading,
  busy,
  error,
  errorWhy,
  errorNext,
  notice,
  volatile,
  writeDenied,
  reviewDenied,
  recoveryAvailable,
  historical,
  historyOpen,
  historyRows,
  cursor,
  historyBusy,
  activeCandidate,
  feedbackCandidate,
  feedbackRevision,
  feedbackBusy,
  feedbackError,
  feedbackWhy,
  feedbackNext,
  draftDirty,
  frozen,
  pending,
  document: doc,
  canExecute,
  canStartNew,
  latest,
} = state;
const root = ref<HTMLElement | null>(null);
let feedbackFocus: HTMLElement | null = null,
  detailFocus: HTMLElement | null = null;
async function returnFocus(trigger: HTMLElement | null) {
  await nextTick();
  if (trigger?.isConnected && root.value?.contains(trigger)) trigger.focus();
  else root.value?.querySelector<HTMLElement>('[data-testid="mc-close"]')?.focus();
}
function openFeedback(
  candidate: import("#/api/market-candidates").Candidate,
  trigger: HTMLElement,
) {
  feedbackFocus = trigger;
  state.openFeedback(candidate);
}
async function openDetail(
  candidate: import("#/api/market-candidates").Candidate,
  trigger: HTMLElement,
) {
  detailFocus = trigger;
  activeCandidate.value = candidate;
  await nextTick();
  root.value?.querySelector<HTMLElement>('[data-testid="mc-detail"]')?.focus();
}
function closeDetail() {
  activeCandidate.value = null;
  void returnFocus(detailFocus);
}
watch(feedbackCandidate, (value, previous) => {
  if (previous && !value) void returnFocus(feedbackFocus);
});
watch(
  () => props.hidden,
  async (hidden) => {
    if (hidden) return;
    await nextTick();
    if (recoveryTrigger?.isConnected) recoveryTrigger.focus();
    else root.value?.querySelector<HTMLElement>('[data-testid="mc-recover-facts"]')?.focus();
  },
);
watch([loading, busy, historyBusy, feedbackBusy, feedbackCandidate, activeCandidate, () => props.hidden], async () => {
  if (props.hidden || leaveConfirmOpen.value) return;
  await nextTick();
  const modal =
    root.value?.querySelector<HTMLElement>('[data-testid="mc-feedback-dialog"]') ?? root.value;
  if (modal && !modal.contains(globalThis.document.activeElement)) {
    const control = modal.querySelector<HTMLElement>(
      "button:not([disabled]),select:not([disabled]),textarea:not([disabled])",
    );
    (control ?? modal).focus();
  }
});
const phaseNames = {
  PREPARED: "phasePrepared",
  RUNNING: "phaseRunning",
  RESULT_UNKNOWN: "phaseResultUnknown",
  RESULT_READY: "phaseResultReady",
  FAILED: "phaseFailed",
  NOT_APPLIED: "phaseNotApplied",
  PERSISTED: "phasePersisted",
};
const phaseName = computed(() =>
  generation.value ? $t(`gainos.marketCandidates.${phaseNames[generation.value.phase]}`) : "",
);
const leaveConfirmOpen = ref(false);
function confirmLeave(): Promise<boolean> {
  if (feedbackBusy.value) return Promise.resolve(false);
  if (!(draftDirty.value || frozen.value)) return Promise.resolve(true);
  if (leaveConfirmOpen.value) return Promise.resolve(false);
  leaveConfirmOpen.value = true;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (allowed: boolean) => {
      if (settled) return;
      settled = true;
      leaveConfirmOpen.value = false;
      if (!allowed) {
        void nextTick(() => restoreFocus());
      }
      resolve(allowed);
    };
    feedback.confirm({
      content: $t("gainos.marketCandidates.leaveWarning"),
      okText: $t("gainos.marketCandidates.close"),
      cancelText: $t("gainos.marketCandidates.cancel"),
      okType: "danger",
      zIndex: 1400,
      onOk: () => finish(true),
      onCancel: () => finish(false),
    });
  });
}
function close() {
  if (feedbackBusy.value) return;
  if (!(draftDirty.value || frozen.value)) {
    emit("close");
    return;
  }
  void confirmLeave().then((allowed) => {
    if (allowed) emit("close");
  });
}
let recoveryTrigger: HTMLElement | null = null;
async function requestRecovery(destination: "facts" | "documents", event: MouseEvent) {
  if (busy.value || feedbackBusy.value || historyBusy.value) return;
  const trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  if (!(await confirmLeave())) return;
  if (trigger) recoveryTrigger = trigger;
  emit("recover", { companyId: props.companyId, destination });
}
async function cancelFeedback() {
  if (!(await confirmLeave())) return;
  state.closeFeedback();
  await returnFocus(feedbackFocus);
}
function focusBoundary() {
  return feedbackCandidate.value
    ? root.value?.querySelector<HTMLElement>('[data-testid="mc-feedback-dialog"]')
    : root.value;
}
function restoreFocus() {
  const boundary = focusBoundary();
  if (!boundary || boundary.contains(globalThis.document.activeElement)) return;
  const target =
    boundary.querySelector<HTMLElement>(
      "button:not([disabled]),select:not([disabled]),textarea:not([disabled]),input:not([disabled])",
    ) ?? boundary;
  target.focus();
}
function focusout(event: FocusEvent) {
  if (props.hidden || leaveConfirmOpen.value) return;
  const related = event.relatedTarget;
  const boundary = focusBoundary();
  if (boundary && related instanceof Node && boundary.contains(related)) return;
  void nextTick(() => {
    if (!props.hidden && !leaveConfirmOpen.value) restoreFocus();
  });
}
function keydown(event: KeyboardEvent) {
  // 面板是模态目标，键盘事件不向全局命令面板/布局冒泡；否则全局 Enter 会触发无关导航。
  event.stopPropagation();
  if (leaveConfirmOpen.value || feedbackCandidate.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    void close();
  }
  if (event.key === "Tab") {
    const nodes = root.value?.querySelectorAll<HTMLElement>(
      "button:not([disabled]),select:not([disabled]),textarea:not([disabled]),input:not([disabled]),summary",
    );
    if (!nodes?.length) return;
    const visible = [...nodes].filter((node) => node.getClientRects().length);
    const index = visible.findIndex((node) => node === globalThis.document.activeElement);
    // 焦点在 tabindex=-1 的详情/面板容器时，交给浏览器原生顺序，避免跳过详情自己的控件。
    if (index < 0) return;
    if (event.shiftKey && index === 0) {
      event.preventDefault();
      visible[visible.length - 1]?.focus();
    } else if (!event.shiftKey && index === visible.length - 1) {
      event.preventDefault();
      visible[0]?.focus();
    }
  }
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (draftDirty.value || frozen.value) {
    event.preventDefault();
    event.returnValue = "";
  }
}
onBeforeRouteLeave(() => confirmLeave());
onMounted(async () => {
  window.addEventListener("beforeunload", beforeUnload);
  await nextTick();
  root.value?.querySelector<HTMLElement>('[data-testid="mc-close"]')?.focus();
});
onBeforeUnmount(() => window.removeEventListener("beforeunload", beforeUnload));
</script>
<template>
  <Teleport to="body"
    ><div v-show="!hidden" class="mc-overlay" :inert="hidden" :aria-hidden="hidden ? 'true' : undefined" @focusout="focusout" @keydown="keydown">
      <section
        ref="root"
        class="mc-panel"
        role="dialog"
        :aria-modal="hidden ? 'false' : 'true'"
        :aria-label="$t('gainos.marketCandidates.title')"
        data-testid="mc-panel"
        tabindex="-1"
      >
        <header class="mc-panel-head">
          <div>
            <h2>{{ $t("gainos.marketCandidates.title") }}</h2>
            <p>{{ companyName }}</p>
          </div>
          <button type="button" data-testid="mc-close" @click="close">
            {{ $t("gainos.marketCandidates.close") }}
          </button>
        </header>
        <p class="mc-description">{{ $t("gainos.marketCandidates.subtitle") }}</p>
        <div class="mc-tools">
          <button
            type="button"
            data-testid="mc-refresh"
            :disabled="loading || busy || feedbackBusy"
            @click="state.refresh"
          >
            {{ $t("gainos.marketCandidates.refresh") }}</button
          ><button
            v-if="doc"
            type="button"
            data-testid="mc-history"
            :disabled="historyBusy || busy"
            @click="state.history()"
          >
            {{ $t("gainos.marketCandidates.history") }}</button
          ><span v-if="doc" data-testid="mc-revision-label">{{
            $t("gainos.marketCandidates.revisionLabel", { revision: doc.revision })
          }}</span
          ><span v-if="historical" data-testid="mc-historical" class="mc-pill">{{
            $t("gainos.marketCandidates.historical")
          }}</span>
        </div>
        <p v-if="volatile" class="mc-warning" role="status">
          {{ $t("gainos.marketCandidates.volatileNotice") }}
        </p>
        <section v-if="error" class="mc-error" data-testid="mc-error" role="alert">
          <p>{{ error }}</p>
          <p v-if="errorWhy" data-testid="mc-error-why">{{ errorWhy }}</p>
          <p v-if="errorNext" data-testid="mc-error-next">{{ errorNext }}</p>
        </section>
        <section v-if="recoveryAvailable" class="mc-recovery" data-testid="mc-recovery">
          <p>{{ $t("gainos.marketCandidates.recoveryHint") }}</p>
          <button type="button" data-testid="mc-recover-facts" :disabled="busy || feedbackBusy || historyBusy" @click="requestRecovery('facts', $event)">
            {{ $t("gainos.marketCandidates.recoveryFacts") }}</button
          ><button type="button" data-testid="mc-recover-documents" :disabled="busy || feedbackBusy || historyBusy" @click="requestRecovery('documents', $event)">
            {{ $t("gainos.marketCandidates.recoveryDocuments") }}
          </button>
        </section>
        <p v-if="notice" data-testid="mc-notice" role="status">{{ notice }}</p>
        <p v-if="loading" role="status">{{ $t("gainos.marketCandidates.loading") }}</p>
        <details v-if="receipt" data-testid="mc-receipt">
          <summary>{{ $t("gainos.marketCandidates.feedbackTitle") }}</summary>
          <p>
            {{
              $t("gainos.marketCandidates.revisionLabel", { revision: receipt.recordedRevision })
            }}
            · {{ formatDateTime(receipt.createdAt) }}
          </p>
          <p class="mc-receipt-reason">
            {{ $t("gainos.marketCandidates.reason") }}:
            {{ receipt.reason ?? $t("gainos.marketCandidates.reasonPlaceholder") }}
          </p>
          <p
            v-if="
              receipt.action === 'CORRECT' &&
              receipt.correction &&
              Object.keys(receipt.correction).length > 0
            "
          >
            {{ $t("gainos.marketCandidates.correctionOverlay") }}
          </p>
        </details>
        <section class="mc-generation">
          <div>
            <p
              v-if="generation"
              data-testid="mc-phase"
              :data-phase="generation.phase"
              role="status"
            >
              {{ phaseName }}
            </p>
            <p
              v-if="
                generation &&
                (generation.reasonCode ||
                  generation.phase === 'FAILED' ||
                  generation.phase === 'NOT_APPLIED')
              "
              data-testid="mc-generation-reason"
            >
              {{ $t("gainos.marketCandidates.reason") }}:
              {{
                generation.reasonCode
                  ? $t(`gainos.marketCandidates.reasonCodes.${generation.reasonCode}`)
                  : $t("gainos.marketCandidates.noReason")
              }}
            </p>
            <p v-if="generation?.phase === 'RESULT_UNKNOWN'">
              {{ $t("gainos.marketCandidates.refreshPending") }}
            </p>
            <p v-if="generation?.set" class="mc-reference" data-testid="mc-initial-reference">
              {{ $t("gainos.marketCandidates.initialReference") }}:
              {{
                $t("gainos.marketCandidates.revisionLabel", { revision: generation.set.revision })
              }}
            </p>
          </div>
          <div class="mc-tools">
            <button
              v-if="canStartNew"
              type="button"
              data-testid="mc-new-intent"
              @click="state.newIntent"
            >
              {{ $t("gainos.marketCandidates.newIntent") }}</button
            ><button
              v-if="!pending?.generationId"
              type="button"
              data-testid="mc-prepare"
              :disabled="busy || writeDenied"
              @click="state.prepare"
            >
              {{ $t("gainos.marketCandidates.prepare") }}</button
            ><button
              v-if="generation?.phase === 'PREPARED'"
              type="button"
              class="mc-primary"
              data-testid="mc-execute"
              :disabled="busy || !canExecute"
              @click="state.execute"
            >
              {{ $t("gainos.marketCandidates.execute") }}</button
            ><button
              v-if="pending?.generationId"
              type="button"
              data-testid="mc-query"
              :disabled="busy"
              @click="state.query()"
            >
              {{ $t("gainos.marketCandidates.refresh") }}</button
            ><button
              v-if="pending?.generationId"
              type="button"
              data-testid="mc-recover"
              :disabled="busy || writeDenied"
              @click="state.query(true)"
            >
              {{ $t("gainos.marketCandidates.recover") }}
            </button>
          </div>
          <p>{{ $t("gainos.marketCandidates.prepareHint") }}</p>
          <p>{{ $t("gainos.marketCandidates.costUnknown") }}</p>
          <p v-if="writeDenied">{{ $t("gainos.marketCandidates.blockedHint") }}</p>
        </section>
        <section
          v-if="!loading && latest?.status === 'NOT_ANALYZED'"
          data-testid="mc-not-analyzed"
          class="mc-empty"
        >
          <h3>
            {{
              $t(
                pending || generation
                  ? "gainos.marketCandidates.noReadableTitle"
                  : "gainos.marketCandidates.notAnalyzedTitle",
              )
            }}
          </h3>
          <p>
            {{
              $t(
                pending || generation
                  ? "gainos.marketCandidates.noReadableDesc"
                  : "gainos.marketCandidates.notAnalyzedDesc",
              )
            }}
          </p>
        </section>
        <section
          v-if="doc?.generationOutcome === 'COMPLETED_EMPTY'"
          class="mc-empty"
          data-testid="mc-empty"
        >
          <h3>{{ $t("gainos.marketCandidates.emptyResult") }}</h3>
          <p>{{ $t("gainos.marketCandidates.emptyResultHint") }}</p>
        </section>
        <RevisionHistory
          v-if="historyOpen"
          :rows="historyRows"
          :has-more="!!cursor"
          :busy="historyBusy || busy"
          @select="state.selectRevision"
          @more="state.history(true)"
          @current="state.refresh"
        />
        <div
          v-if="doc && selected"
          class="mc-layout"
          :class="{ 'mc-layout--detail': activeCandidate }"
        >
          <div class="mc-cards">
            <CandidateCard
              v-for="c in doc.candidates"
              :key="c.candidateId"
              :candidate="c"
              :read-only="historical || selected.historical"
              :review-denied="reviewDenied"
              :selected="activeCandidate?.candidateId === c.candidateId"
              @details="openDetail(c, $event)"
              @feedback="openFeedback(c, $event)"
            />
          </div>
          <CandidateDetail
            v-if="activeCandidate"
            :candidate="activeCandidate"
            :revision="selected"
            @close="closeDetail"
          />
        </div>
        <section data-testid="mc-b4" class="mc-b4">
          <h3>{{ $t("gainos.marketCandidates.b4Title") }}</h3>
          <p>{{ $t("gainos.marketCandidates.b4Boundary") }}</p>
        </section>
        <section
          v-if="ownDraft && !feedbackCandidate"
          data-testid="mc-held-draft"
          class="mc-generation"
        >
          <h3>{{ $t("gainos.marketCandidates.heldDraft") }}</h3>
          <p>{{ $t("gainos.marketCandidates.heldDraftHint") }}</p>
          <p>{{ ownDraft.reason }}</p>
          <dl>
            <div v-for="(value, key) in ownDraft.correction" :key="key">
              <dt>{{ $t(`gainos.marketCandidates.correctionFields.${key}`) }}</dt>
              <dd>
                {{
                  Array.isArray(value)
                    ? value.join(" / ")
                    : (value ?? $t("gainos.marketCandidates.unknown"))
                }}
              </dd>
            </div>
          </dl>
          <button
            v-if="canResumeDraft"
            type="button"
            data-testid="mc-resume-draft"
            @click="state.resumeOwnDraft"
          >
            {{ $t("gainos.marketCandidates.resumeDraft") }}
          </button>
        </section>
        <FeedbackDialog
          v-if="feedbackCandidate"
          :candidate="feedbackCandidate"
          :revision="feedbackRevision"
          :busy="feedbackBusy"
          :error="feedbackError"
          :error-why="feedbackWhy"
          :error-next="feedbackNext"
          :frozen="frozen"
          :denied="reviewDenied || state.readDenied.value"
          :known-refusal="feedbackFailure === 'KNOWN'"
          :unknown-outcome="feedbackFailure === 'UNKNOWN'"
          :current="feedbackCurrent"
          :current-revision="feedbackCurrentRevision"
          :checked="feedbackChecked"
          :checking="feedbackChecking"
          :initial-draft="ownDraft"
          @submit="state.saveFeedback"
          @cancel="cancelFeedback"
          @dirty="draftDirty = $event"
          @draft="state.ownDraftChanged"
          @check="state.checkFeedbackCurrent"
          @redecide="state.redecideFeedback"
        />
      </section></div
  ></Teleport>
</template>
<style>
.mc-overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  background: var(--gs-mask);
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 24px;
}
.mc-panel {
  position: relative;
  background: var(--gs-surface);
  color: var(--gs-fg);
  border: 1px solid var(--gs-border-strong);
  border-radius: 20px;
  box-shadow: var(--gs-shadow-modal);
  width: min(1200px, 100%);
  max-height: calc(100dvh - 48px);
  overflow: auto;
  padding: 24px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.mc-panel button,
.mc-panel select,
.mc-panel input,
.mc-panel textarea {
  font: inherit;
  color: inherit;
}
.mc-panel button {
  min-height: 40px;
  border: 1px solid var(--gs-border-strong);
  border-radius: 8px;
  padding: 7px 13px;
  background: var(--gs-surface);
  cursor: pointer;
}
.mc-panel button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.mc-panel button:focus-visible,
.mc-panel summary:focus-visible,
.mc-panel textarea:focus-visible,
.mc-panel select:focus-visible {
  outline: 3px solid var(--gs-accent-strong);
  outline-offset: 3px;
}
.mc-panel .mc-primary {
  color: var(--gs-accent-cta-fg);
  background: var(--gs-accent-cta);
  border-color: var(--gs-accent-cta);
}
.mc-panel h2 {
  font-size: 24px;
  font-weight: 700;
}
.mc-panel h3 {
  font-size: 18px;
  font-weight: 650;
}
.mc-panel h4 {
  font-size: 15px;
  font-weight: 650;
}
.mc-panel-head,
.mc-card header,
.mc-detail header {
  display: flex;
  justify-content: space-between;
  align-items: start;
  gap: 12px;
}
.mc-description {
  color: var(--gs-fg-muted);
  max-width: 90ch;
  margin: 12px 0 18px;
}
.mc-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin: 12px 0;
}
.mc-generation,
.mc-b4,
.mc-history,
.mc-empty {
  padding: 16px;
  background: var(--gs-surface-2);
  border-radius: 12px;
  margin: 16px 0;
}
.mc-generation p,
.mc-b4 p {
  margin: 4px 0;
}
.mc-layout {
  display: grid;
  grid-template-columns: 1fr;
  gap: 18px;
}
.mc-layout--detail {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}
.mc-cards {
  display: grid;
  align-content: start;
  gap: 14px;
}
.mc-card,
.mc-detail {
  border: 1px solid var(--gs-border-strong);
  border-radius: 14px;
  padding: 18px;
  min-width: 0;
}
.mc-card--selected {
  border-color: var(--gs-accent-strong);
}
.mc-card h3 {
  margin: 14px 0;
}
.mc-card dl > div,
.mc-detail dl > div {
  display: grid;
  grid-template-columns: minmax(90px, 35%) 1fr;
  gap: 12px;
  margin: 8px 0;
}
.mc-card dt {
  color: var(--gs-fg-muted);
}
.mc-card footer {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}
.mc-pill {
  font-size: 13px;
  display: inline-block;
  border: 1px solid var(--gs-border-strong);
  padding: 2px 8px;
  border-radius: 20px;
}
.mc-conclusion {
  border-top: 1px solid var(--gs-border);
  margin-top: 16px;
  padding-top: 12px;
}
.mc-statement,
.mc-source {
  background: var(--gs-surface-2);
  padding: 12px;
  border-radius: 8px;
  margin: 10px 0;
}
.mc-detail section {
  margin: 18px 0;
}
.mc-receipt-reason {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.mc-error {
  color: var(--gs-danger);
  padding: 12px;
  border: 1px solid var(--gs-danger-border);
  border-radius: 8px;
}
.mc-warning {
  color: var(--gs-warn);
}
.mc-feedback-mask {
  position: fixed;
  inset: 0;
  z-index: 1250;
  background: var(--gs-mask);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.mc-feedback-dialog {
  background: var(--gs-surface);
  border: 1px solid var(--gs-border-strong);
  border-radius: 16px;
  padding: 24px;
  max-height: calc(100dvh - 40px);
  overflow: auto;
  width: min(700px, 100%);
}
.mc-feedback-dialog label {
  display: grid;
  gap: 6px;
  margin: 14px 0;
}
.mc-feedback-dialog textarea,
.mc-feedback-dialog select {
  width: 100%;
  background: var(--gs-surface);
  border: 1px solid var(--gs-border-strong);
  border-radius: 8px;
  padding: 10px;
}
.mc-feedback-dialog footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.mc-corrections {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 14px;
}
.mc-history ul {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 12px 0;
}
.mc-reference {
  font-size: 13px;
  color: var(--gs-fg-muted);
}
@media (max-width: 760px) {
  .mc-overlay {
    padding: 0;
  }
  .mc-panel {
    width: 100%;
    height: 100dvh;
    max-height: 100dvh;
    border-radius: 0;
    padding: 16px;
  }
  .mc-layout--detail {
    grid-template-columns: 1fr;
  }
  .mc-corrections {
    grid-template-columns: 1fr;
  }
  .mc-feedback-mask {
    padding: 8px;
  }
  .mc-feedback-dialog {
    padding: 16px;
  }
  .mc-tools {
    gap: 8px;
  }
  .mc-panel-head h2 {
    font-size: 22px;
  }
}
</style>

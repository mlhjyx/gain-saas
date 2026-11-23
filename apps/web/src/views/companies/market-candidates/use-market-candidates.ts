import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import { $t } from "#/locales";
import { newAttemptId } from "#/utils/attempt-id";
import {
  marketCandidatesApi as api,
  uuid,
  type Candidate,
  type Correction,
  type FeedbackInput,
  type FeedbackResult,
  type Generation,
  type Latest,
  type Revision,
  type RevisionPage,
} from "#/api/market-candidates";

export type UserFeedbackDraft = {
  action: FeedbackInput["action"];
  reason: string;
  correction: Correction;
};

type PendingReference = {
  context: string;
  intentId: string;
  generationId?: string;
  attempted: boolean;
  rejectedBeforeDispatch?: true;
};
const STORAGE = "gainos-market-candidate-pending-v1";
export function useMarketCandidates(company: Ref<string>, context: Ref<string>) {
  const latest = ref<Latest | null>(null),
    selected = ref<Revision | null>(null),
    generation = ref<Generation | null>(null);
  const loading = ref(false),
    busy = ref(false),
    error = ref(""),
    errorWhy = ref(""),
    errorNext = ref(""),
    notice = ref(""),
    volatile = ref(false);
  const readDenied = ref(false),
    writeDenied = ref(false),
    reviewDenied = ref(false),
    recoveryAvailable = ref(false);
  const historical = ref(false),
    historyOpen = ref(false),
    historyRows = ref<RevisionPage["revisions"]>([]),
    cursor = ref<string | null>(null),
    historyBusy = ref(false);
  const activeCandidate = ref<Candidate | null>(null),
    feedbackCandidate = ref<Candidate | null>(null),
    feedbackRevision = ref(0),
    feedbackSet = ref("");
  const feedbackBusy = ref(false),
    feedbackError = ref(""),
    feedbackWhy = ref(""),
    feedbackNext = ref(""),
    draftDirty = ref(false),
    frozen = ref(false);
  const pending = ref<PendingReference | null>(null);
  const receipt = ref<FeedbackResult | null>(null);
  const ownDraft = ref<UserFeedbackDraft | null>(null);
  const draftTarget = ref<{ set: string; candidate: string } | null>(null);
  const feedbackFailure = ref<"" | "KNOWN" | "UNKNOWN">("");
  const feedbackCurrent = ref<Candidate | null>(null),
    feedbackCurrentRevision = ref(0);
  const feedbackChecked = ref(false),
    feedbackChecking = ref(false);
  let feedbackRequest: { key: string; body: FeedbackInput; set: string; candidate: string } | null =
    null;
  let epoch = 0,
    readSeq = 0,
    latestLoadingSeq = 0,
    controller = new AbortController();
  // In-memory validation commitment only: never persisted, displayed, or used as permission authority.
  let generationIdentity: Pick<Generation, "generationId" | "intentDigest"> | null = null;
  const key = computed(() => JSON.stringify([context.value, company.value]));
  const document = computed(() => selected.value?.document ?? null);
  const canStartNew = computed(
    () =>
      !!generation.value &&
      ["PERSISTED", "FAILED", "NOT_APPLIED"].includes(generation.value.phase) &&
      !busy.value &&
      !writeDenied.value &&
      !readDenied.value,
  );
  const canExecute = computed(
    () =>
      !!generation.value &&
      generation.value.phase === "PREPARED" &&
      !pending.value?.attempted &&
      !writeDenied.value &&
      !readDenied.value,
  );
  function persist() {
    try {
      const raw: unknown = JSON.parse(sessionStorage.getItem(STORAGE) ?? "[]");
      const rows = (Array.isArray(raw) ? raw : [])
        .filter(
          (x: PendingReference) =>
            x &&
            typeof x.context === "string" &&
            x.context.length <= 1024 &&
            x.context !== key.value &&
            uuid(x.intentId) &&
            (!x.generationId || uuid(x.generationId)) &&
            typeof x.attempted === "boolean",
        )
        .slice(-7)
        .map((x: PendingReference) => ({
          context: x.context,
          intentId: x.intentId,
          ...(x.generationId ? { generationId: x.generationId } : {}),
          attempted: x.attempted,
          ...(x.rejectedBeforeDispatch === true ? { rejectedBeforeDispatch: true as const } : {}),
        }));
      if (pending.value) rows.push(pending.value);
      sessionStorage.setItem(STORAGE, JSON.stringify(rows));
    } catch {
      volatile.value = true;
    }
  }
  function restore() {
    try {
      const raw = sessionStorage.getItem(STORAGE);
      if (!raw) return;
      if (raw.length > 16000) throw new Error("reference storage too large");
      const data: unknown = JSON.parse(raw);
      if (!Array.isArray(data)) throw new Error("invalid references");
      const item = data
        .slice(-8)
        .find(
          (v: PendingReference) =>
            v?.context === key.value &&
            uuid(v.intentId) &&
            (!v.generationId || uuid(v.generationId)) &&
            typeof v.attempted === "boolean",
        );
      if (item)
        pending.value = {
          context: key.value,
          intentId: item.intentId,
          generationId: item.generationId,
          attempted: item.attempted,
          ...(item.rejectedBeforeDispatch === true
            ? { rejectedBeforeDispatch: true as const }
            : {}),
        };
    } catch {
      volatile.value = true;
    }
  }
  function errorCode(e: unknown) {
    return (
      (e as { response?: { data?: { error?: { code?: string }; meta?: { engineCode?: string } } } })
        ?.response?.data?.error?.code ??
      (e as { response?: { data?: { meta?: { engineCode?: string } } } })?.response?.data?.meta
        ?.engineCode ??
      ""
    );
  }
  function errorStatus(e: unknown) {
    return (e as { response?: { status?: number } })?.response?.status;
  }
  function trustedErrorCopy(err: unknown) {
    const copy = (
      err as {
        response?: {
          data?: {
            error?: { userCopy?: { title?: unknown; why?: unknown; next?: unknown } };
          };
        };
      }
    )?.response?.data?.error?.userCopy;
    if (typeof copy?.title !== "string" || !copy.title.trim()) return null;
    return copy;
  }
  function safeErrorCopy(err: unknown) {
    const copy = trustedErrorCopy(err);
    return {
      title:
        typeof copy?.title === "string" && copy.title.trim()
          ? copy.title
          : $t("gainos.marketCandidates.errorFallbackTitle"),
      why:
        typeof copy?.why === "string" && copy.why
          ? copy.why
          : $t("gainos.marketCandidates.errorFallbackWhy"),
      next:
        typeof copy?.next === "string" && copy.next
          ? copy.next
          : $t("gainos.marketCandidates.errorFallbackNext"),
    };
  }
  function clearError() {
    error.value = "";
    errorWhy.value = "";
    errorNext.value = "";
  }
  function setError(err: unknown) {
    const copy = safeErrorCopy(err);
    error.value = errorMessage(err);
    errorWhy.value = copy.why;
    errorNext.value = copy.next;
  }
  function clearFeedbackError() {
    feedbackError.value = "";
    feedbackWhy.value = "";
    feedbackNext.value = "";
  }
  function setFeedbackError(err: unknown) {
    const copy = safeErrorCopy(err);
    feedbackError.value = errorMessage(err);
    feedbackWhy.value = copy.why;
    feedbackNext.value = copy.next;
  }
  function errorMessage(e: unknown) {
    const p = (
      e as { response?: { data?: { error?: { code?: string }; meta?: { engineCode?: string } } } }
    )?.response?.data;
    const code = p?.error?.code ?? p?.meta?.engineCode ?? "";
    if (code === "VERSION_CONFLICT") return $t("gainos.marketCandidates.versionConflict");
    if (code === "IDEMPOTENCY_CONFLICT") return $t("gainos.marketCandidates.idempotencyConflict");
    if ((e as Error)?.message === "MARKET_CANDIDATE_RESPONSE_INVALID")
      return $t("gainos.marketCandidates.unreadable");
    return safeErrorCopy(e).title;
  }
  function denied(e: unknown) {
    const p = (
      e as {
        response?: {
          status?: number;
          data?: {
            error?: { code?: string };
            meta?: { engineStatus?: number; engineCode?: string };
          };
        };
      }
    )?.response;
    const code = p?.data?.error?.code ?? p?.data?.meta?.engineCode ?? "";
    return (
      p?.status === 403 ||
      p?.status === 404 ||
      p?.data?.meta?.engineStatus === 403 ||
      ["FORBIDDEN", "NOT_FOUND", "NOT_A_MEMBER", "SCOPE_REQUIRED", "SCOPE_MISMATCH"].includes(
        code,
      ) ||
      code.endsWith("_SCOPE_MISMATCH") ||
      code.endsWith("_FORBIDDEN")
    );
  }
  function clearReadable(withdrawGeneration = true) {
    readSeq++;
    latestLoadingSeq++;
    loading.value = false;
    if (withdrawGeneration) generation.value = null;
    latest.value = null;
    selected.value = null;
    activeCandidate.value = null;
    historical.value = false;
    historyRows.value = [];
    cursor.value = null;
    receipt.value = null;
    notice.value = "";
    feedbackCandidate.value = null;
    feedbackCurrent.value = null;
    feedbackChecked.value = false;
    recoveryAvailable.value = false;
  }
  async function refresh() {
    const e = epoch,
      s = ++readSeq,
      ownLoading = ++latestLoadingSeq;
    loading.value = true;
    clearError();
    try {
      const result = await api.latest(company.value, controller.signal);
      if (e !== epoch || s !== readSeq) return false;
      if (result.result && result.result.document.companyId !== company.value)
        throw new Error("MARKET_CANDIDATE_RESPONSE_INVALID");
      if (document.value?.setId !== result.result?.document.setId) {
        historyRows.value = [];
        cursor.value = null;
        historyOpen.value = false;
      }
      latest.value = result;
      selected.value = result.result;
      historical.value = false;
      readDenied.value = false;
      activeCandidate.value = null;
      return true;
    } catch (err) {
      if (e !== epoch) return;
      if (denied(err) || s === readSeq) {
        clearReadable(denied(err));
        readDenied.value = readDenied.value || denied(err);
        setError(err);
        loading.value = false;
      }
      return false;
    } finally {
      if (e === epoch && ownLoading === latestLoadingSeq) loading.value = false;
    }
  }
  function guardGeneration(result: Generation) {
    if (
      result.companyId !== company.value ||
      result.intentId !== pending.value?.intentId ||
      (pending.value?.generationId && result.generationId !== pending.value.generationId) ||
      (generation.value?.generationId === result.generationId &&
        generation.value.intentDigest !== result.intentDigest) ||
      (generationIdentity &&
        (generationIdentity.generationId !== result.generationId ||
          generationIdentity.intentDigest !== result.intentDigest))
    )
      throw new Error("MARKET_CANDIDATE_RESPONSE_INVALID");
  }
  async function applyGeneration(result: Generation, e: number) {
    if (e !== epoch) return;
    guardGeneration(result);
    generationIdentity ??= { generationId: result.generationId, intentDigest: result.intentDigest };
    if (pending.value) {
      pending.value.generationId = result.generationId;
      persist();
    }
    if (result.phase === "PERSISTED" && result.set) {
      let initial: Revision;
      try {
        initial = await api.revision(result.set.setId, 1, controller.signal);
      } catch (err) {
        if (e === epoch && denied(err)) {
          clearReadable();
          readDenied.value = true;
        }
        throw err;
      }
      if (e !== epoch) return;
      if (
        initial.document.companyId !== company.value ||
        initial.document.setId !== result.set.setId ||
        initial.document.revision !== 1 ||
        initial.documentHash !== result.set.documentHash
      )
        throw new Error("MARKET_CANDIDATE_RESPONSE_INVALID");
      await refresh();
    }
    if (e === epoch && !readDenied.value) generation.value = result;
  }
  async function prepare() {
    if (busy.value || writeDenied.value || pending.value?.generationId) return;
    busy.value = true;
    recoveryAvailable.value = false;
    clearError();
    const e = epoch;
    if (!pending.value) {
      pending.value = { context: key.value, intentId: newAttemptId(), attempted: false };
      persist();
    }
    const intent = pending.value.intentId;
    let received = false;
    try {
      const result = await api.prepare(company.value, { intentId: intent }, controller.signal);
      received = true;
      await applyGeneration(result, e);
    } catch (err) {
      if (e === epoch) {
        setError(err);
        if (!received && denied(err)) writeDenied.value = true;
        recoveryAvailable.value =
          !received &&
          errorStatus(err) === 400 &&
          ["VALIDATION_ERROR", "NO_APPROVED_CLAIMS"].includes(errorCode(err));
      }
    } finally {
      if (e === epoch) busy.value = false;
    }
  }
  async function execute() {
    if (busy.value || !canExecute.value || !generation.value) return;
    busy.value = true;
    clearError();
    const e = epoch;
    const g = generation.value;
    if (pending.value) {
      pending.value.attempted = true;
      delete pending.value.rejectedBeforeDispatch;
      persist();
    }
    let received = false;
    try {
      const result = await api.execute(
        g.generationId,
        { intentDigest: g.intentDigest },
        controller.signal,
      );
      received = true;
      await applyGeneration(result, e);
    } catch (err) {
      if (e === epoch) {
        if (
          !received &&
          errorStatus(err) === 402 &&
          errorCode(err) === "WORKSPACE_BUDGET_EXCEEDED"
        ) {
          generation.value = readDenied.value ? null : g;
          if (pending.value) {
            pending.value.rejectedBeforeDispatch = true;
            persist();
          }
        } else
          generation.value =
            received || readDenied.value
              ? null
              : { ...g, phase: "RESULT_UNKNOWN", reasonCode: "RESULT_UNKNOWN", set: null };
        setError(err);
        if (!received && denied(err)) writeDenied.value = true;
      }
    } finally {
      if (e === epoch) busy.value = false;
    }
  }
  async function newIntent() {
    if (!canStartNew.value || !window.confirm($t("gainos.marketCandidates.newIntentConfirm")))
      return;
    generationIdentity = null;
    recoveryAvailable.value = false;
    pending.value = null;
    generation.value = null;
    persist();
    await prepare();
  }
  async function query(recover = false) {
    const id = pending.value?.generationId;
    if (!id || busy.value || (recover && writeDenied.value)) return;
    busy.value = true;
    clearError();
    const e = epoch;
    let received = false;
    try {
      const result = await (recover
        ? api.recover(id, controller.signal)
        : api.generation(id, controller.signal));
      received = true;
      await applyGeneration(result, e);
      if (e === epoch && pending.value && !recover) {
        if (result.phase === "PREPARED" && pending.value.rejectedBeforeDispatch === true)
          pending.value.attempted = false;
        delete pending.value.rejectedBeforeDispatch;
        persist();
      }
    } catch (err) {
      if (e === epoch) {
        generation.value = null;
        setError(err);
        if (denied(err)) {
          clearReadable();
          if (recover && !received) writeDenied.value = true;
          else readDenied.value = true;
        }
      }
    } finally {
      if (e === epoch) busy.value = false;
    }
  }
  async function history(more = false) {
    if (historyBusy.value || !document.value || readDenied.value) return;
    historyOpen.value = true;
    historyBusy.value = true;
    const e = epoch;
    const set = document.value.setId;
    try {
      const page = await api.revisions(
        set,
        { limit: 20, ...(more && cursor.value ? { cursor: cursor.value } : {}) },
        controller.signal,
      );
      if (e !== epoch || document.value?.setId !== set) return;
      historyRows.value = more
        ? [
            ...historyRows.value,
            ...page.revisions.filter(
              (x) => !historyRows.value.some((y) => y.revision === x.revision),
            ),
          ]
        : page.revisions;
      cursor.value = page.nextCursor;
    } catch (err) {
      if (e === epoch) {
        setError(err);
        if (denied(err)) {
          clearReadable();
          readDenied.value = true;
        }
      }
    } finally {
      if (e === epoch) historyBusy.value = false;
    }
  }
  async function selectRevision(number: number) {
    if (!document.value || busy.value) return;
    const set = document.value.setId;
    const e = epoch,
      s = ++readSeq;
    busy.value = true;
    clearError();
    try {
      const result = await api.revision(set, number, controller.signal);
      if (e !== epoch || s !== readSeq || readDenied.value) return;
      if (
        result.document.companyId !== company.value ||
        result.document.setId !== set ||
        result.document.revision !== number
      )
        throw new Error("MARKET_CANDIDATE_RESPONSE_INVALID");
      selected.value = result;
      historical.value = true;
      activeCandidate.value = null;
    } catch (err) {
      if (e === epoch && (denied(err) || s === readSeq)) {
        clearReadable(denied(err));
        setError(err);
        readDenied.value = readDenied.value || denied(err);
      }
    } finally {
      if (e === epoch) busy.value = false;
    }
  }
  function ownDraftChanged(value: UserFeedbackDraft) {
    ownDraft.value = structuredClone(value);
    draftDirty.value = true;
  }
  function openFeedback(c: Candidate) {
    if (
      feedbackBusy.value ||
      historical.value ||
      readDenied.value ||
      !document.value ||
      reviewDenied.value
    )
      return;
    if (
      draftDirty.value &&
      ownDraft.value &&
      !window.confirm($t("gainos.marketCandidates.leaveWarning"))
    )
      return;
    closeFeedback();
    feedbackCandidate.value = c;
    feedbackRevision.value = document.value.revision;
    feedbackSet.value = document.value.setId;
    draftTarget.value = { set: document.value.setId, candidate: c.candidateId };
  }
  function closeFeedback() {
    feedbackCandidate.value = null;
    feedbackRequest = null;
    clearFeedbackError();
    draftDirty.value = false;
    frozen.value = false;
    ownDraft.value = null;
    draftTarget.value = null;
    feedbackFailure.value = "";
    feedbackCurrent.value = null;
    feedbackChecked.value = false;
  }
  async function checkFeedbackCurrent() {
    if (
      feedbackBusy.value ||
      feedbackChecking.value ||
      feedbackFailure.value !== "KNOWN" ||
      !draftTarget.value
    )
      return;
    const e = epoch;
    feedbackChecking.value = true;
    feedbackChecked.value = false;
    try {
      const ok = await refresh();
      if (!ok || e !== epoch) return;
      const doc = document.value;
      const current =
        doc?.setId === draftTarget.value?.set
          ? doc.candidates.find((c) => c.candidateId === draftTarget.value?.candidate)
          : undefined;
      if (!current || !doc) {
        clearFeedbackError();
        feedbackError.value = $t("gainos.marketCandidates.notFound");
        return;
      }
      feedbackCurrent.value = current;
      feedbackCurrentRevision.value = doc.revision;
      feedbackChecked.value = true;
    } finally {
      if (e === epoch) feedbackChecking.value = false;
    }
  }
  function redecideFeedback() {
    if (
      !feedbackChecked.value ||
      !feedbackCurrent.value ||
      !document.value ||
      readDenied.value ||
      reviewDenied.value ||
      feedbackBusy.value ||
      feedbackFailure.value !== "KNOWN"
    )
      return;
    feedbackRequest = null;
    feedbackCandidate.value = feedbackCurrent.value;
    feedbackRevision.value = feedbackCurrentRevision.value;
    feedbackSet.value = document.value.setId;
    draftTarget.value = { set: feedbackSet.value, candidate: feedbackCandidate.value.candidateId };
    frozen.value = false;
    feedbackFailure.value = "";
    clearFeedbackError();
    feedbackChecked.value = false;
    feedbackCurrent.value = null;
  }
  const canResumeDraft = computed(
    () =>
      !!ownDraft.value &&
      !historical.value &&
      !selected.value?.historical &&
      !readDenied.value &&
      !!document.value &&
      draftTarget.value?.set === document.value.setId &&
      document.value.candidates.some((c) => c.candidateId === draftTarget.value?.candidate),
  );
  function resumeOwnDraft() {
    if (!canResumeDraft.value || !document.value || !draftTarget.value || feedbackBusy.value)
      return;
    const c = document.value.candidates.find((c) => c.candidateId === draftTarget.value?.candidate);
    if (!c) return;
    feedbackCandidate.value = c;
    feedbackSet.value = draftTarget.value.set;
    feedbackRevision.value = feedbackRequest?.body.expectedRevision ?? document.value.revision;
    frozen.value = !!feedbackRequest;
    clearFeedbackError();
    feedbackError.value = feedbackRequest ? $t("gainos.marketCandidates.feedbackUnknown") : "";
  }
  async function saveFeedback(input: FeedbackInput) {
    if (
      feedbackBusy.value ||
      !feedbackCandidate.value ||
      reviewDenied.value ||
      readDenied.value ||
      (frozen.value && feedbackFailure.value === "KNOWN")
    )
      return;
    const e = epoch;
    if (!feedbackRequest)
      feedbackRequest = {
        key: newAttemptId(),
        body: structuredClone(input),
        set: feedbackSet.value,
        candidate: feedbackCandidate.value.candidateId,
      };
    const request = feedbackRequest;
    frozen.value = true;
    feedbackBusy.value = true;
    clearFeedbackError();
    feedbackFailure.value = "";
    try {
      const result = await api.feedback(
        request.set,
        request.candidate,
        request.body,
        request.key,
        controller.signal,
      );
      if (e !== epoch || feedbackRequest !== request) return;
      const ok = await refresh();
      if (e !== epoch || feedbackRequest !== request) return;
      if (!ok) {
        feedbackFailure.value = "UNKNOWN";
        clearFeedbackError();
        feedbackError.value = $t("gainos.marketCandidates.refreshPending");
        return;
      }
      receipt.value = result;
      notice.value = $t("gainos.marketCandidates.saved");
      closeFeedback();
    } catch (err) {
      if (e === epoch) {
        setFeedbackError(err);
        const status = errorStatus(err),
          code = errorCode(err);
        feedbackFailure.value =
          denied(err) ||
          status === 400 ||
          status === 409 ||
          status === 422 ||
          code === "VERSION_CONFLICT" ||
          code === "IDEMPOTENCY_CONFLICT"
            ? "KNOWN"
            : "UNKNOWN";
        if (denied(err)) reviewDenied.value = true;
      }
    } finally {
      if (e === epoch) feedbackBusy.value = false;
    }
  }
  function dispose() {
    epoch++;
    generationIdentity = null;
    controller.abort();
    controller = new AbortController();
  }
  watch(
    key,
    () => {
      dispose();
      readSeq = 0;
      clearReadable();
      generation.value = null;
      pending.value = null;
      receipt.value = null;
      closeFeedback();
      clearError();
      notice.value = "";
      loading.value = false;
      busy.value = false;
      feedbackBusy.value = false;
      feedbackChecking.value = false;
      historyBusy.value = false;
      historyOpen.value = false;
      readDenied.value = false;
      writeDenied.value = false;
      reviewDenied.value = false;
      recoveryAvailable.value = false;
      restore();
      if (uuid(company.value) && context.value) void refresh();
    },
    { immediate: true },
  );
  onScopeDispose(dispose);
  return {
    ownDraft,
    draftTarget,
    feedbackFailure,
    feedbackCurrent,
    feedbackCurrentRevision,
    feedbackChecked,
    feedbackChecking,
    canResumeDraft,
    ownDraftChanged,
    checkFeedbackCurrent,
    redecideFeedback,
    resumeOwnDraft,
    receipt,
    latest,
    selected,
    generation,
    loading,
    busy,
    error,
    errorWhy,
    errorNext,
    notice,
    volatile,
    readDenied,
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
    document,
    canExecute,
    canStartNew,
    newIntent,
    refresh,
    prepare,
    execute,
    query,
    history,
    selectRevision,
    openFeedback,
    closeFeedback,
    saveFeedback,
  };
}

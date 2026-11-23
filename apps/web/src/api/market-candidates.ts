import type { components, paths } from "@gain-saas/engine-client";
import { requestClient } from "#/api/request";

type Schemas = components["schemas"];
export type Candidate = Schemas["MarketCandidateDto"];
export type Statement = Schemas["MarketCandidateStatementDto"];
export type Revision = Schemas["MarketCandidateRevisionDto"];
export type Latest = Schemas["MarketCandidateLatestDto"];
export type Generation = Schemas["MarketCandidateGenerationDto"];
export type Correction = Schemas["MarketCandidateCorrectionDto"];
export type FeedbackInput = Schemas["MarketCandidateFeedbackInputDto"];
export type FeedbackResult = Schemas["MarketCandidateFeedbackResultDto"];
export type RevisionPage = Schemas["MarketCandidateRevisionPageDto"];
export type RevisionQuery =
  paths["/api/v1/market-candidate-sets/{setId}/revisions"]["get"]["parameters"]["query"];
export const phases: readonly Generation["phase"][] = [
  "PREPARED",
  "RUNNING",
  "RESULT_UNKNOWN",
  "RESULT_READY",
  "FAILED",
  "NOT_APPLIED",
  "PERSISTED",
];
export const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[\da-f]{8}-[\da-f]{4}-[1-5][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[\da-f]{64}$/i.test(v);
const text = (v: unknown): v is string => typeof v === "string";
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
const nullableText = (v: unknown) => v === null || text(v);
function ensure(value: unknown): asserts value {
  if (!value) throw new Error("MARKET_CANDIDATE_RESPONSE_INVALID");
}
const knowledge = ["SELLER_ASSERTION", "REVIEWED_SOURCE_FACT", "INFERENCE", "CONFLICT", "UNKNOWN"];
function validStatement(v: unknown): boolean {
  return (
    object(v) &&
    text(v.text) &&
    knowledge.includes(String(v.knowledgeState)) &&
    strings(v.basisKeys) &&
    text(v.impact)
  );
}
function validCorrection(v: unknown): boolean {
  if (!object(v)) return false;
  const stringKeys = ["supplyDescription", "application", "organizationRole", "fitExplanation"];
  const countryKeys = ["buyerOrganizationCountry", "projectCountry"];
  const arrayKeys = ["entryConditions", "gaps", "nextVerification"];
  return Object.entries(v).every(([key, value]) =>
    stringKeys.includes(key)
      ? text(value)
      : countryKeys.includes(key)
        ? nullableText(value)
        : arrayKeys.includes(key) && strings(value),
  );
}
function validCandidate(v: unknown): boolean {
  if (!object(v) || !object(v.proposal)) return false;
  const p = v.proposal;
  return (
    uuid(v.candidateId) &&
    validCorrection(v.corrections) &&
    ["PENDING", "CONFIRMED", "CORRECTED", "PENDING_EVIDENCE", "REJECTED"].includes(
      String(v.feedback),
    ) &&
    typeof v.needsReassessment === "boolean" &&
    ["NONE", "UNKNOWN"].includes(String(v.impactScope)) &&
    object(p.supplyOrCapability) &&
    uuid(p.supplyOrCapability.offeringId) &&
    text(p.supplyOrCapability.description) &&
    nullableText(p.buyerOrganizationCountry) &&
    nullableText(p.projectCountry) &&
    [p.application, p.organizationRole, p.fitExplanation].every(validStatement) &&
    [p.entryConditions, p.support, p.counterEvidence, p.gaps].every(
      (rows) => Array.isArray(rows) && rows.every(validStatement),
    ) &&
    object(p.recommendation) &&
    ["COMPARABLE", "CONDITIONAL", "INSUFFICIENT_EVIDENCE", "NOT_RECOMMENDED"].includes(
      String(p.recommendation.status),
    ) &&
    text(p.recommendation.reason) &&
    strings(p.nextVerification)
  );
}
function availability(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every(
      (x) =>
        object(x) &&
        text(x.key) &&
        ["CURRENT", "CHANGED", "UNAVAILABLE", "UNKNOWN"].includes(String(x.status)) &&
        [
          "MATCHED",
          "VERSION_OR_DIGEST_CHANGED",
          "SOURCE_UNAVAILABLE",
          "FINGERPRINT_UNKNOWN",
        ].includes(String(x.reason)),
    )
  );
}
export function assertRevision(v: unknown): asserts v is Revision {
  ensure(object(v) && object(v.document));
  const d = v.document;
  ensure(
    d.schemaVersion === "market-candidate-set/v1" &&
      uuid(d.setId) &&
      uuid(d.companyId) &&
      integer(d.revision) &&
      ["CANDIDATES_PROPOSED", "COMPLETED_EMPTY"].includes(String(d.generationOutcome)) &&
      Array.isArray(d.candidates) &&
      d.candidates.every(validCandidate) &&
      (d.generationOutcome === "COMPLETED_EMPTY"
        ? d.candidates.length === 0
        : d.candidates.length > 0),
  );
  ensure(
    new Set(d.candidates.map((x) => (x as Candidate).candidateId)).size === d.candidates.length,
  );
  ensure(
    hash(v.documentHash) &&
      uuid(v.createdBy) &&
      text(v.createdAt) &&
      typeof v.historical === "boolean" &&
      availability(v.basisAvailability),
  );
  ensure(
    object(d.basisSnapshot) &&
      object(d.basisSnapshot.company) &&
      d.basisSnapshot.company.companyId === d.companyId &&
      integer(d.basisSnapshot.company.version) &&
      Array.isArray(d.basisSnapshot.sources),
  );
  for (const s of d.basisSnapshot.sources) {
    ensure(
      object(s) &&
        ["OFFERING", "CLAIM", "EVIDENCE", "SELLER_DOCUMENT", "SELLER_DOCUMENT_CHUNK"].includes(
          String(s.kind),
        ) &&
        uuid(s.sourceId) &&
        text(s.key) &&
        (s.version === null || integer(s.version)) &&
        nullableText(s.status) &&
        text(s.digest) &&
        nullableText(s.contentHash) &&
        nullableText(s.parentId) &&
        nullableText(s.parentContentHash) &&
        nullableText(s.sourceDate),
    );
    if (s.position !== null) {
      ensure(object(s.position));
      for (const k of ["seq", "page", "quoteStart", "quoteEnd"])
        ensure(s.position[k] === null || Number.isSafeInteger(s.position[k]));
      ensure(nullableText(s.position.section));
    }
  }
}
function assertGeneration(v: unknown): asserts v is Generation {
  ensure(
    object(v) &&
      uuid(v.generationId) &&
      uuid(v.companyId) &&
      uuid(v.intentId) &&
      hash(v.intentDigest) &&
      phases.includes(v.phase as Generation["phase"]) &&
      text(v.preparedAt) &&
      text(v.updatedAt),
  );
  ensure(
    v.reasonCode === null ||
      [
        "BASIS_UNAVAILABLE",
        "BASIS_CHANGED",
        "SUPERSEDED",
        "VERSION_CONFLICT",
        "OUTPUT_INVALID",
        "EXECUTION_REJECTED",
        "EXECUTION_FAILED",
        "RESULT_UNKNOWN",
        "RESULT_NOT_FOUND",
        "SAVE_PENDING",
      ].includes(String(v.reasonCode)),
  );
  ensure(
    v.set === null ||
      (object(v.set) && uuid(v.set.setId) && v.set.revision === 1 && hash(v.set.documentHash)),
  );
  ensure(v.phase === "PERSISTED" ? v.set !== null : v.set === null);
  ensure(
    v.execution === null ||
      (object(v.execution) &&
        uuid(v.execution.operationId) &&
        v.execution.resultSchema === "market-candidates-generation/v1" &&
        hash(v.execution.resultDigest) &&
        text(v.execution.ackId)),
  );
}
const id = (v: string) => {
  ensure(uuid(v));
  return encodeURIComponent(v);
};
const cfg = (signal?: AbortSignal) => ({ signal, errorToastHandledInline: true });
async function gen(promise: Promise<unknown>) {
  const v = await promise;
  assertGeneration(v);
  return v;
}
async function rev(promise: Promise<unknown>) {
  const v = await promise;
  assertRevision(v);
  return v;
}
// requestClient already unwraps exactly one envelope. Never unwrap a second data field.
export const marketCandidatesApi = {
  async latest(company: string, signal?: AbortSignal): Promise<Latest> {
    const v: unknown = await requestClient.get(
      `/companies/${id(company)}/market-candidate-sets/latest`,
      cfg(signal),
    );
    ensure(object(v));
    ensure(v.status === "NOT_ANALYZED" || v.status === "AVAILABLE");
    if (v.status === "AVAILABLE") assertRevision(v.result);
    else ensure(v.result === null);
    return v as Latest;
  },
  current: (set: string, signal?: AbortSignal) =>
    rev(requestClient.get(`/market-candidate-sets/${id(set)}`, cfg(signal))),
  revision: (set: string, number: number, signal?: AbortSignal) => {
    ensure(integer(number));
    return rev(
      requestClient.get(`/market-candidate-sets/${id(set)}/revisions/${number}`, cfg(signal)),
    );
  },
  async revisions(
    set: string,
    query: RevisionQuery = {},
    signal?: AbortSignal,
  ): Promise<RevisionPage> {
    const v: unknown = await requestClient.get(`/market-candidate-sets/${id(set)}/revisions`, {
      ...cfg(signal),
      params: query,
    });
    ensure(
      object(v) &&
        Array.isArray(v.revisions) &&
        (v.nextCursor === null || (text(v.nextCursor) && /^[1-9]\d*$/.test(v.nextCursor))),
    );
    ensure(
      v.revisions.every(
        (x) =>
          object(x) &&
          integer(x.revision) &&
          hash(x.documentHash) &&
          uuid(x.createdBy) &&
          text(x.createdAt),
      ),
    );
    return v as RevisionPage;
  },
  prepare: (
    company: string,
    body: Schemas["MarketCandidateGenerationPrepareDto"],
    signal?: AbortSignal,
  ) =>
    gen(
      requestClient.post(
        `/companies/${id(company)}/market-candidate-generations`,
        body,
        cfg(signal),
      ),
    ),
  generation: (generation: string, signal?: AbortSignal) =>
    gen(requestClient.get(`/market-candidate-generations/${id(generation)}`, cfg(signal))),
  execute: (
    generation: string,
    body: Schemas["MarketCandidateGenerationExecuteDto"],
    signal?: AbortSignal,
  ) =>
    gen(
      requestClient.post(
        `/market-candidate-generations/${id(generation)}/execute`,
        body,
        cfg(signal),
      ),
    ),
  recover: (generation: string, signal?: AbortSignal) =>
    gen(
      requestClient.post(
        `/market-candidate-generations/${id(generation)}/recover`,
        {},
        cfg(signal),
      ),
    ),
  async feedback(
    set: string,
    candidate: string,
    body: FeedbackInput,
    key: string,
    signal?: AbortSignal,
  ): Promise<FeedbackResult> {
    ensure(uuid(key));
    const v: unknown = await requestClient.post(
      `/market-candidate-sets/${id(set)}/candidates/${id(candidate)}/feedback`,
      body,
      { ...cfg(signal), headers: { "idempotency-key": key } },
    );
    ensure(
      object(v) &&
        uuid(v.feedbackId) &&
        v.setId === set &&
        v.candidateId === candidate &&
        integer(v.recordedRevision) &&
        hash(v.documentHash) &&
        ["CONFIRM", "CORRECT", "KEEP_PENDING", "REJECT"].includes(String(v.action)) &&
        v.action === body.action &&
        nullableText(v.reason) &&
        (v.correction === null || validCorrection(v.correction)) &&
        validCandidate(v.before) &&
        validCandidate(v.after) &&
        uuid(v.actorId) &&
        text(v.createdAt) &&
        typeof v.replayed === "boolean" &&
        availability(v.basisAvailability),
    );
    return v as FeedbackResult;
  },
};

import { copyForError } from "@gain-saas/shared";
import type { components } from "@gain-saas/engine-client";
import type { Page, Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { installMockBackend } from "./mock-backend";

type S = components["schemas"];
export const ID = {
  company: "11111111-1111-4111-8111-111111111111",
  second: "22222222-2222-4222-8222-222222222222",
  set: "33333333-3333-4333-8333-333333333333",
  candidate: "44444444-4444-4444-8444-444444444444",
  generation: "55555555-5555-4555-8555-555555555555",
  actor: "66666666-6666-4666-8666-666666666666",
  offering: "77777777-7777-4777-8777-777777777777",
};
export const NOW = "2026-11-22T01:00:00.000Z";
export const HASH = "a".repeat(64);
export const matrix = (["zh-CN", "en-US"] as const).flatMap((lang) =>
  (["light", "dark"] as const).flatMap((theme) =>
    (["desktop", "narrow"] as const).map((width) => ({
      lang,
      theme,
      width,
      label: `${lang}-${theme}-${width}`,
    })),
  ),
);
export type Cell = (typeof matrix)[number];
export function statement(
  text: string,
  knowledgeState: S["MarketCandidateStatementDto"]["knowledgeState"] = "INFERENCE",
): S["MarketCandidateStatementDto"] {
  return {
    text,
    knowledgeState,
    basisKeys: [`OFFERING:${ID.offering}`],
    impact: "This condition applies only to this combination.",
  };
}
export function candidate(): S["MarketCandidateDto"] {
  return {
    candidateId: ID.candidate,
    corrections: {},
    feedback: "PENDING",
    needsReassessment: false,
    impactScope: "NONE",
    proposal: {
      supplyOrCapability: { offeringId: ID.offering, description: "Battery cells / 电池片" },
      buyerOrganizationCountry: "FR",
      projectCountry: null,
      application: statement("Solar installations / 光伏项目"),
      organizationRole: statement("Distributor hypothesis / 分销商假设"),
      fitExplanation: statement(
        "Compatible supply, purchasing relationship unverified / 采购关系待证",
      ),
      entryConditions: [statement("Certification required / 需要认证", "SELLER_ASSERTION")],
      support: [statement("Saved capacity claim / 已保存产能声明", "REVIEWED_SOURCE_FACT")],
      counterEvidence: [statement("Conflicting delivery lead times / 交期冲突", "CONFLICT")],
      gaps: [statement("Buyer demand unknown / 买方需求未知", "UNKNOWN")],
      recommendation: {
        status: "CONDITIONAL",
        reason: "Conditional on certification / 取决于认证",
      },
      nextVerification: ["Check purchasing relationship / 核实采购关系"],
    },
  };
}
export function revision(number = 1): S["MarketCandidateRevisionDto"] {
  const a = candidate();
  const b = structuredClone(a);
  b.candidateId = "88888888-8888-4888-8888-888888888888";
  b.proposal.application = statement("Roof projects / 屋顶项目");
  return {
    document: {
      schemaVersion: "market-candidate-set/v1",
      setId: ID.set,
      companyId: ID.company,
      revision: number,
      generationOutcome: "CANDIDATES_PROPOSED",
      candidates: [a, b],
      basisSnapshot: {
        company: { companyId: ID.company, version: 2 },
        sources: [
          {
            kind: "OFFERING",
            sourceId: ID.offering,
            key: `OFFERING:${ID.offering}`,
            version: 2,
            status: "ACTIVE",
            digest: HASH,
            contentHash: HASH,
            parentId: null,
            parentContentHash: null,
            position: { seq: 1, page: null, section: "Supply", quoteStart: 0, quoteEnd: 20 },
            sourceDate: NOW,
          },
        ],
      },
    },
    documentHash: number === 1 ? HASH : "b".repeat(64),
    createdBy: ID.actor,
    createdAt: NOW,
    historical: false,
    basisAvailability: [{ key: `OFFERING:${ID.offering}`, status: "CURRENT", reason: "MATCHED" }],
  };
}
export function generation(
  phase: S["MarketCandidateGenerationDto"]["phase"] = "PREPARED",
): S["MarketCandidateGenerationDto"] {
  return {
    generationId: ID.generation,
    companyId: ID.company,
    intentId: ID.actor,
    intentDigest: HASH,
    phase,
    reasonCode: phase === "RESULT_READY" ? "SAVE_PENDING" : null,
    preparedAt: NOW,
    updatedAt: NOW,
    set: phase === "PERSISTED" ? { setId: ID.set, revision: 1, documentHash: HASH } : null,
    execution: null,
  };
}
export async function setup(page: Page, cell: Cell) {
  const origin = process.env.B3_TEST_ORIGIN ?? "http://127.0.0.1:4173";
  const errors: string[] = [],
    forbidden: string[] = [],
    blockedOrigins: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.context().routeWebSocket("**/*", (socket) => socket.close());
  const backend = await installMockBackend(page, { origin });
  backend.set("GET", "/companies", [
    { id: ID.company, name: "Synthetic Seller", status: "ACTIVE", created_at: NOW },
    { id: ID.second, name: "Second Seller", status: "ACTIVE", created_at: NOW },
  ]);
  const state = {
    latest: { status: "AVAILABLE", result: revision() } as S["MarketCandidateLatestDto"],
    gen: generation(),
    deny: "" as "" | "read" | "write" | "review",
    losePrepare: false,
    loseExecute: false,
    loseFeedback: false,
    conflict: "",
    malformed: false,
    noHistory: false,
    historyPages: 0,
    latestWait: null as Promise<void> | null,
    revisionWait: null as Promise<void> | null,
    feedbackWait: null as Promise<void> | null,
    badInitial: false,
    prepareError: "",
    prepareErrorStatus: 0 as number,
    revisionReadError: "",
    prepareBasis: "VALID" as "VALID" | "NO_OFFERINGS" | "NO_APPROVED_CLAIMS",
    noCopy: false,
    recoverError: "",
    executeError: "",
    feedbackWrites: 0,
    executionDispatches: 0,
    feedbackReplays: 0,
  };
  const requests: Array<{ method: string; path: string; body: unknown; key?: string }> = [];
  const receipts = new Map<
    string,
    { body: string; result: S["MarketCandidateFeedbackResultDto"] }
  >();
  const intents = new Map<string, { body: string; generationId: string; digest: string }>();
  const operations = new Map<string, { intentId: string; digest: string; executed: boolean }>();
  const revisions = new Map<number, S["MarketCandidateRevisionDto"]>([[1, revision(1)]]);
  const uuid = (v: unknown): v is string =>
    typeof v === "string" && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(v);
  const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  function canonical(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (record(v))
      return `{${Object.keys(v)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
        .join(",")}}`;
    return JSON.stringify(v);
  }
  const only = (v: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(v).every((k) => keys.includes(k));
  function sendError(
    route: import("@playwright/test").Route,
    code: string,
    status = ["VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT"].includes(code) ? 409 : 502,
    copyOverride?: { title: string; why: string; next: string },
  ) {
    const copy = copyOverride ?? (state.noCopy ? null : safeErrorCopy(code, cell.lang));
    return route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify({
        error: copy
          ? { code, userCopy: { title: copy.title, why: copy.why, next: copy.next } }
          : { code, message: "SYNTHETIC_INTERNAL_DETAILS_NOT_FOR_UI" },
        meta: { engineCode: code, engineMessage: "SYNTHETIC_INTERNAL_DETAILS_NOT_FOR_UI" },
      }),
    });
  }
  function advanceCurrent(target?: number, application?: string) {
    const old = state.latest.result;
    if (!old) throw new Error("No current synthetic document");
    revisions.set(old.document.revision, structuredClone(old));
    const next = structuredClone(old);
    next.document.revision = target ?? old.document.revision + 1;
    if (application) next.document.candidates[0]!.corrections.application = application;
    next.documentHash = "b".repeat(64);
    next.historical = false;
    state.latest = { status: "AVAILABLE", result: next };
    revisions.set(next.document.revision, structuredClone(next));
  }
  function effective(
    c: S["MarketCandidateDto"],
    key: keyof S["MarketCandidateCorrectionDto"],
  ): unknown {
    if (c.corrections[key] !== undefined) return c.corrections[key];
    const p = c.proposal;
    switch (key) {
      case "supplyDescription":
        return p.supplyOrCapability.description;
      case "application":
        return p.application.text;
      case "organizationRole":
        return p.organizationRole.text;
      case "fitExplanation":
        return p.fitExplanation.text;
      case "entryConditions":
        return p.entryConditions.map((x) => x.text);
      case "gaps":
        return p.gaps.map((x) => x.text);
      default:
        return p[key];
    }
  }
  function validFeedback(value: unknown): value is S["MarketCandidateFeedbackInputDto"] {
    if (
      !record(value) ||
      !only(value, ["expectedRevision", "action", "reason", "correction"]) ||
      !Number.isInteger(value.expectedRevision) ||
      Number(value.expectedRevision) < 1 ||
      Number(value.expectedRevision) > 2147483647 ||
      !["CONFIRM", "CORRECT", "KEEP_PENDING", "REJECT"].includes(String(value.action))
    )
      return false;
    if (
      value.reason !== undefined &&
      value.reason !== null &&
      (typeof value.reason !== "string" || value.reason.length > 2000)
    )
      return false;
    if (value.action !== "CORRECT") return value.correction === undefined;
    const c = value.correction;
    if (
      !record(c) ||
      !Object.keys(c).length ||
      !only(c, [
        "supplyDescription",
        "buyerOrganizationCountry",
        "projectCountry",
        "application",
        "organizationRole",
        "fitExplanation",
        "entryConditions",
        "gaps",
        "nextVerification",
      ])
    )
      return false;
    return Object.entries(c).every(([key, v]) =>
      ["entryConditions", "gaps", "nextVerification"].includes(key)
        ? Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === "string")
        : ["buyerOrganizationCountry", "projectCountry"].includes(key)
          ? v === null || (typeof v === "string" && /^[A-Z]{2}$/.test(v))
          : typeof v === "string" && v.length <= 2000,
    );
  }
  await page.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin !== origin) {
      blockedOrigins.push(url.origin);
      return route.abort("blockedbyclient");
    }
    const path = url.pathname.replace(/^\/api(?=\/)/, ""),
      method = req.method();
    if (
      ["script", "stylesheet", "font", "image"].includes(req.resourceType()) ||
      req.isNavigationRequest() ||
      !path.includes("market-candidate")
    )
      return route.fallback();
    let body: unknown;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    requests.push({ method, path, body, key: req.headers()["idempotency-key"] });
    const write = method === "POST",
      feedback = path.endsWith("/feedback");
    if (
      (state.deny === "read" && !write) ||
      (state.deny === "write" && write && !feedback) ||
      (state.deny === "review" && feedback)
    )
      return sendError(route, "NOT_A_MEMBER", 403);
    const reply = (data: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data }),
      });
    if (req.headers()["x-execution-budget-grant"])
      return sendError(route, "CLIENT_GRANT_FORBIDDEN", 400);
    if (method === "GET" && path === `/companies/${ID.company}/market-candidate-sets/latest`) {
      if (state.latestWait) await state.latestWait;
      if (state.deny === "read") return sendError(route, "NOT_A_MEMBER", 403);
      if (state.latest.result)
        revisions.set(state.latest.result.document.revision, structuredClone(state.latest.result));
      return reply(state.malformed ? { status: "AVAILABLE", result: {} } : state.latest);
    }
    if (method === "GET" && path === `/companies/${ID.second}/market-candidate-sets/latest`)
      return reply({ status: "NOT_ANALYZED", result: null });
    if (method === "GET" && path === `/market-candidate-sets/${ID.set}`)
      return state.latest.result ? reply(state.latest.result) : sendError(route, "NOT_FOUND", 404);
    if (method === "GET" && path === `/market-candidate-sets/${ID.set}/revisions`) {
      state.historyPages++;
      const current = state.latest.result;
      if (!current) return sendError(route, "NOT_FOUND", 404);
      const cursor = url.searchParams.get("cursor"),
        limit = url.searchParams.get("limit");
      if (
        (cursor && !/^[1-9]\d*$/.test(cursor)) ||
        (limit && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100))
      )
        return sendError(route, "VALIDATION_ERROR", 400);
      const n = cursor ? Number(cursor) : current.document.revision;
      if (n > current.document.revision) return sendError(route, "NOT_FOUND", 404);
      const item = revisions.get(n) ?? revision(n);
      return reply({
        revisions: [
          {
            revision: n,
            documentHash: item.documentHash,
            createdAt: item.createdAt,
            createdBy: item.createdBy,
          },
        ],
        nextCursor: n > 1 ? String(n - 1) : null,
      });
    }
    if (
      method === "GET" &&
      new RegExp(`^/market-candidate-sets/${ID.set}/revisions/[1-9]\\d*$`).test(path)
    ) {
      if (state.revisionWait) await state.revisionWait;
      if (state.revisionReadError && Number(path.split("/").at(-1)) === 1)
        return sendError(route, state.revisionReadError, 400);
      if (state.noHistory) return sendError(route, "SCOPE_REQUIRED");
      const n = Number(path.split("/").at(-1));
      const currentRevision = state.latest.result?.document.revision ?? 0;
      if (n > currentRevision && n !== 1) return sendError(route, "NOT_FOUND", 404);
      const rev = structuredClone(revisions.get(n) ?? revision(n));
      rev.historical = true;
      if (state.badInitial && n === 1) rev.documentHash = "c".repeat(64);
      return reply(rev);
    }
    if (method === "POST" && path === `/companies/${ID.company}/market-candidate-generations`) {
      if (
        !record(body) ||
        !uuid(body.intentId) ||
        !only(body, ["intentId", "offeringIds", "claimIds"]) ||
        [body.offeringIds, body.claimIds].some(
          (v) => v !== undefined && (!Array.isArray(v) || v.length > 200 || !v.every(uuid)),
        )
      )
        return sendError(route, "VALIDATION_ERROR", 400);
      if (state.prepareError)
        return sendError(
          route,
          state.prepareError,
          state.prepareErrorStatus || undefined,
          state.prepareErrorStatus === 502 ? serviceIdentityCopy(cell.lang) : undefined,
        );
      const previous = intents.get(body.intentId);
      if (previous && previous.body !== canonical(body))
        return sendError(route, "IDEMPOTENCY_CONFLICT");
      // Fixed B2 reuses an allocated intent before validating a new allocation's source rows.
      if (!previous && state.prepareBasis === "NO_OFFERINGS")
        return sendError(route, "VALIDATION_ERROR", 400);
      if (!previous && state.prepareBasis === "NO_APPROVED_CLAIMS")
        return sendError(route, "NO_APPROVED_CLAIMS", 400);
      const g = previous ?? {
        body: canonical(body),
        generationId:
          intents.size === 0
            ? ID.generation
            : `90000000-0000-4000-8000-${String(intents.size).padStart(12, "0")}`,
        digest: HASH,
      };
      intents.set(body.intentId, g);
      if (!operations.has(g.generationId))
        operations.set(g.generationId, {
          intentId: body.intentId,
          digest: g.digest,
          executed: false,
        });
      if (state.losePrepare) {
        state.losePrepare = false;
        return route.abort();
      }
      return reply({
        ...state.gen,
        generationId: g.generationId,
        intentId: body.intentId,
        intentDigest: g.digest,
      });
    }
    const operationMatch = path.match(
      /^\/market-candidate-generations\/([^/]+)(?:\/(execute|recover))?$/,
    );
    if (operationMatch) {
      const generationId = operationMatch[1]!,
        action = operationMatch[2],
        operation = operations.get(generationId);
      if (!uuid(generationId) || !operation) return sendError(route, "NOT_FOUND", 404);
      const result = () => ({
        ...state.gen,
        generationId,
        intentId: operation.intentId,
        intentDigest: operation.digest,
      });
      if (method === "GET" && !action) return reply(result());
      if (method === "POST" && action === "execute") {
        if (
          !record(body) ||
          Object.keys(body).length !== 1 ||
          body.intentDigest !== operation.digest
        )
          return sendError(route, "VALIDATION_ERROR", 400);
        if (state.executeError)
          return sendError(
            route,
            state.executeError,
            state.executeError === "WORKSPACE_BUDGET_EXCEEDED" ? 402 : 502,
          );
        if (!operation.executed) {
          operation.executed = true;
          state.executionDispatches++;
        }
        if (state.loseExecute) {
          state.loseExecute = false;
          return route.abort();
        }
        return reply(result());
      }
      if (method === "POST" && action === "recover") {
        if (body !== undefined && (!record(body) || Object.keys(body).length))
          return sendError(route, "VALIDATION_ERROR", 400);
        if (state.recoverError) return sendError(route, state.recoverError);
        return reply(result());
      }
    }
    const feedbackMatch = path.match(
      /^\/market-candidate-sets\/([^/]+)\/candidates\/([^/]+)\/feedback$/,
    );
    if (method === "POST" && feedbackMatch) {
      if (state.feedbackWait) await state.feedbackWait;
      const key = req.headers()["idempotency-key"];
      if (!uuid(key) || !validFeedback(body)) return sendError(route, "VALIDATION_ERROR", 400);
      if (state.conflict) return sendError(route, state.conflict);
      // Existing B1 validates DTO length first, normalizes blank to null, and keeps nonblank bytes.
      const normalizedReason = body.reason?.trim() ? body.reason : null;
      const normalizedBody = { ...body, reason: normalizedReason };
      const oldReceipt = receipts.get(key);
      if (oldReceipt) {
        if (oldReceipt.body !== canonical(normalizedBody))
          return sendError(route, "IDEMPOTENCY_CONFLICT");
        state.feedbackReplays++;
        return reply({ ...oldReceipt.result, replayed: true });
      }
      const current = state.latest.result;
      if (!current || feedbackMatch[1] !== current.document.setId)
        return sendError(route, "NOT_FOUND", 404);
      const index = current.document.candidates.findIndex(
        (c) => c.candidateId === feedbackMatch[2],
      );
      if (index < 0) return sendError(route, "NOT_FOUND", 404);
      if (body.expectedRevision !== current.document.revision)
        return sendError(route, "VERSION_CONFLICT");
      const before = structuredClone(current.document.candidates[index]!);
      if (
        body.action === "CORRECT" &&
        !Object.entries(body.correction ?? {}).some(
          ([k, v]) =>
            canonical(v) !==
            canonical(effective(before, k as keyof S["MarketCandidateCorrectionDto"])),
        )
      )
        return sendError(route, "CORRECTION_NOT_CHANGED", 400);
      const after = structuredClone(before);
      const labels = {
        CONFIRM: "CONFIRMED",
        CORRECT: "CORRECTED",
        KEEP_PENDING: "PENDING_EVIDENCE",
        REJECT: "REJECTED",
      } as const;
      after.feedback = labels[body.action];
      if (body.correction)
        after.corrections = { ...after.corrections, ...structuredClone(body.correction) };
      after.needsReassessment = after.needsReassessment || body.action === "CORRECT";
      revisions.set(current.document.revision, structuredClone(current));
      const next = structuredClone(current);
      next.document.revision++;
      next.documentHash = "b".repeat(64);
      next.document.candidates[index] = after;
      next.historical = false;
      state.latest = { status: "AVAILABLE", result: next };
      revisions.set(next.document.revision, structuredClone(next));
      const result: S["MarketCandidateFeedbackResultDto"] = {
        feedbackId: ID.actor,
        setId: next.document.setId,
        candidateId: after.candidateId,
        recordedRevision: next.document.revision,
        documentHash: next.documentHash,
        action: body.action,
        reason: normalizedReason,
        correction: body.correction ?? null,
        before,
        after,
        actorId: ID.actor,
        createdAt: NOW,
        replayed: false,
        basisAvailability: next.basisAvailability,
      };
      if (receipts.size >= 100) throw new Error("Synthetic ledger bound exceeded");
      receipts.set(key, { body: canonical(normalizedBody), result: structuredClone(result) });
      state.feedbackWrites++;
      if (state.loseFeedback) {
        state.loseFeedback = false;
        return route.abort();
      }
      return reply(result);
    }
    forbidden.push(`${method} ${path}`);
    return route.fulfill({
      status: 599,
      body: JSON.stringify({ error: { code: "UNDECLARED_B3_REQUEST" } }),
    });
  });
  await page.setViewportSize(
    cell.width === "desktop" ? { width: 1440, height: 900 } : { width: 390, height: 844 },
  );
  await page.goto("/auth/login");
  if (cell.lang === "en-US") await page.getByRole("button", { name: "Switch to English" }).click();
  if (cell.theme === "dark") await page.getByRole("button", { name: "Switch to dark" }).click();
  if (cell.lang === "en-US" || cell.theme === "dark") {
    // 偏好保存 debounce 150ms；登录后 page.goto 是整页重载，等落盘再继续。
    await page.waitForTimeout(250);
  }
  await page.locator("input[type=email]").fill("e2e@gainos.local");
  await page.locator("input[type=password]").fill("e2e-password-123");
  await page.locator("button.g-submit").click();
  await page.waitForURL(/\/workspace/);
  await page.goto("/companies");
  let actionStart: number | null = null;
  const open = async (second = false) => {
    if (actionStart === null) actionStart = backend.calls.length;
    const row = page.locator(".cp__table tbody tr").nth(second ? 1 : 0);
    await row.locator("summary").click();
    await row
      .getByRole("button", {
        name: cell.lang === "zh-CN" ? "市场候选" : "Market candidates",
        exact: true,
      })
      .click();
    await expect(page.getByTestId("mc-panel")).toBeVisible();
    await expect(
      page.getByTestId("mc-panel").getByRole("heading", {
        level: 2,
        name: cell.lang === "zh-CN" ? "市场候选" : "Market candidates",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveClass(
      cell.theme === "dark" ? /dark/ : /^(?!.*\bdark\b).*$/,
    );
  };
  return {
    backend,
    state,
    requests,
    errors,
    forbidden,
    blockedOrigins,
    open,
    advanceCurrent,
    check: () => {
      console.log(
        JSON.stringify({
          kind: "PRIVATE_BROWSER_MOCK_WIRE",
          cell: cell.label,
          requests,
          blockedOrigins,
          mockLedger: {
            feedbackWrites: state.feedbackWrites,
            feedbackReplays: state.feedbackReplays,
            executionDispatches: state.executionDispatches,
          },
        }),
      );
      expect(errors).toEqual([]);
      expect(forbidden).toEqual([]);
      expect(
        backend.calls
          .slice(actionStart ?? backend.calls.length)
          .filter((c) =>
            /model|embedding|search|execution-budget|icps|query-plan|discovery|send|activate|contacts/.test(
              c.path,
            ),
          ),
      ).toEqual([]);
    },
    button: (key: string) => page.getByTestId(`mc-${key}`),
  };
}
export function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function accessibleState(page: Page) {
  const panel = page.getByTestId("mc-panel");
  if (!(await panel.isVisible())) return;
  const dialog = (await page.getByTestId("mc-feedback-dialog").isVisible())
    ? page.getByTestId("mc-feedback-dialog")
    : panel;
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  const focused = await page.evaluate(() =>
    document.activeElement instanceof HTMLElement
      ? getComputedStyle(document.activeElement).outlineStyle
      : "none",
  );
  expect(focused).not.toBe("none");
  const size = await panel.evaluate((e) => ({ scroll: e.scrollWidth, width: e.clientWidth }));
  expect(size.scroll).toBeLessThanOrEqual(size.width + 1);
}

const substateSequence = new WeakMap<object, number>();
/** Evidence only: called after a visible-state assertion, never creates an application action. */
export async function captureState(page: Page, cell: Cell, label: string, anchor?: Locator) {
  if (label.startsWith("feedback-dialog-open"))
    await expect(page.getByTestId("mc-feedback-dialog")).toBeVisible();
  if (label === "feedback-dialog-closed")
    await expect(page.getByTestId("mc-feedback-dialog")).toHaveCount(0);
  const info = test.info();
  const sequence = (substateSequence.get(info) ?? 0) + 1;
  substateSequence.set(info, sequence);
  if (anchor && (await anchor.count())) await anchor.scrollIntoViewIfNeeded();
  const name = `substate-${String(sequence).padStart(3, "0")}-${label.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: "image/png" });
  const view = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-testid="mc-panel"]');
    const dialog = document.querySelector<HTMLElement>('[data-testid="mc-feedback-dialog"]');
    return {
      width: innerWidth,
      height: innerHeight,
      pathname: location.pathname,
      phase: document.querySelector('[data-testid="mc-phase"]')?.getAttribute("data-phase") ?? null,
      feedbackAction:
        document.querySelector<HTMLSelectElement>('[data-testid="mc-feedback-action"]')?.value ??
        null,
      candidateFeedbackLabels: [
        ...document.querySelectorAll('[data-testid="mc-card"] .mc-pill'),
      ].map((node) => node.textContent),
      revisionLabel:
        document.querySelector('[data-testid="mc-revision-label"]')?.textContent ?? null,
      panelScrollTop: panel?.scrollTop ?? null,
      dialogScrollTop: dialog?.scrollTop ?? null,
      feedbackDialogVisible: !!dialog && dialog.getClientRects().length > 0,
      focusedTestId: document.activeElement?.getAttribute("data-testid") ?? null,
      dark: document.documentElement.classList.contains("dark"),
    };
  });
  console.log(
    JSON.stringify({
      kind: "PRIVATE_BROWSER_MOCK_SUBSTATE",
      cell: cell.label,
      label,
      sequence,
      attachment: name,
      view,
    }),
  );
}

/** Exact frozen BFF error-copy projection; this is synthetic response data, not real permission evidence. */
export async function observeToasts(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as {
      __mcToastSeen?: boolean;
      __mcToastObserver?: MutationObserver;
    };
    w.__mcToastSeen = false;
    w.__mcToastObserver?.disconnect();
    w.__mcToastObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (
            node instanceof HTMLElement &&
            (node.matches(".ant-message-notice") || node.querySelector(".ant-message-notice"))
          ) {
            w.__mcToastSeen = true;
          }
        }
      }
    });
    w.__mcToastObserver.observe(document.body, { childList: true, subtree: true });
  });
}
export async function toastWasSeen(page: Page): Promise<boolean> {
  return page.evaluate(
    () => Boolean((window as unknown as { __mcToastSeen?: boolean }).__mcToastSeen),
  );
}
export function serviceIdentityCopy(lang: string) {
  return lang === "zh-CN"
    ? {
        title: "服务授权校验暂未通过",
        why: "当前请求的服务间授权校验未通过，不能据此判断你需要重新登录或个人无权。",
        next: "请联系平台运营检查服务授权；已有执行结果未确认时，先查询原操作，不要直接再次执行。",
      }
    : {
        title: "Service authorization could not be verified",
        why: "The request failed a service-to-service authorization check. This alone does not show that you need to sign in again or lack personal access.",
        next: "Ask platform support to check service authorization. If an earlier execution is unconfirmed, check that operation before executing again.",
      };
}

export function prepareCopy(code: string, lang: string) {
  if (code === "VALIDATION_ERROR")
    return lang === "zh-CN"
      ? {
          title: "暂时无法准备市场候选",
          why: "本次输入或依据未通过校验，仅凭此错误码不能确定具体原因。",
          next: "该公司行有“查看档案”时可核对已有事实，也可从“更多 → 资料库”核对原文；没有可用入口或仍失败时联系管理员。",
        }
      : {
          title: "Market candidates could not be prepared",
          why: "The input or basis did not pass validation. This error code alone does not identify the specific cause.",
          next: "Use View profile if shown for this company, or More → Documents to check source material. If no suitable entry is available or preparation still fails, contact a workspace admin.",
        };
  if (code === "NO_APPROVED_CLAIMS")
    return lang === "zh-CN"
      ? {
          title: "没有可用于本次准备的已批准企业事实",
          why: "市场候选需要有效且已批准的本公司事实。",
          next: "该公司行有“查看档案”时，核对“待确认/已通过”事实并请有权限的管理员处理；没有入口或仍失败时联系管理员，再由用户明确重试。",
        }
      : {
          title: "No approved facts are available for this preparation",
          why: "Market candidates require valid, approved facts for this company.",
          next: "Where View profile is available, review To review and Approved facts with an authorized admin. If no entry is available or preparation still fails, contact an admin, then retry explicitly.",
        };
  return safeErrorCopy(code, lang);
}
export function safeErrorCopy(code: string, lang: string) {
  if (code === "SCOPE_REQUIRED")
    return lang === "zh-CN"
      ? {
          title: "服务授权校验暂未通过",
          why: "当前请求的服务间授权校验未通过，不能据此判断你需要重新登录或个人无权。",
          next: "请联系平台运营检查服务授权；已有执行结果未确认时，先查询原操作，不要直接再次执行。",
        }
      : {
          title: "Service authorization could not be verified",
          why: "The request failed a service-to-service authorization check. This alone does not show that you need to sign in again or lack personal access.",
          next: "Ask platform support to check service authorization. If an earlier execution is unconfirmed, check that operation before executing again.",
        };
  return copyForError(code, lang);
}
async function keyboardMark(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return null;
    const style = getComputedStyle(element);
    return {
      testId: element.getAttribute("data-testid"),
      tag: element.tagName,
      text: element.textContent?.slice(0, 160),
      visible: element.getClientRects().length > 0,
      inPanel: !!element.closest('[data-testid="mc-panel"]'),
      outline: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
    };
  });
}
export async function keyboardReach(page: Page, cell: Cell, label: string, target: Locator) {
  await expect(target).toBeVisible();
  await expect(target).toBeEnabled();
  const steps = [await keyboardMark(page)];
  let reached = false;
  for (let i = 0; i < 80; i++) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      reached = true;
      break;
    }
    await page.keyboard.press("Tab");
    const step = await keyboardMark(page);
    steps.push(step);
    expect(step?.inPanel).toBe(true);
  }
  expect(reached).toBe(true);
  const final = await keyboardMark(page);
  expect(final?.visible).toBe(true);
  expect(final?.outline).not.toBe("none");
  console.log(
    JSON.stringify({
      kind: "PRIVATE_BROWSER_KEYBOARD_PATH",
      cell: cell.label,
      label,
      mode: "REAL_TAB_FROM_CURRENT_PRODUCT_FOCUS_NO_TEST_FOCUS_CALL",
      steps,
      reached: final,
    }),
  );
}
export async function keyboardActivate(page: Page, cell: Cell, label: string, target: Locator) {
  await keyboardReach(page, cell, label, target);
  await captureState(page, cell, `keyboard-before-${label}`, target);
  await page.keyboard.press("Enter");
}
export async function keyboardSelect(page: Page, cell: Cell, action: string) {
  const select = page.getByTestId("mc-feedback-action");
  await keyboardReach(page, cell, `select-${action}`, select);
  await page.keyboard.press("Home");
  const index = ["CONFIRM", "CORRECT", "KEEP_PENDING", "REJECT"].indexOf(action);
  expect(index).toBeGreaterThanOrEqual(0);
  for (let i = 0; i < index; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await expect(select).toHaveValue(action);
  await captureState(page, cell, `keyboard-selected-${action}`);
  console.log(
    JSON.stringify({
      kind: "PRIVATE_BROWSER_KEYBOARD_SELECT",
      cell: cell.label,
      action,
      actualValue: await select.inputValue(),
      testSelectOptionUsed: false,
    }),
  );
}
export async function keyboardType(
  page: Page,
  cell: Cell,
  label: string,
  target: Locator,
  value: string,
) {
  await keyboardReach(page, cell, label, target);
  await page.keyboard.press("Control+A");
  await page.keyboard.type(value);
  await expect(target).toHaveValue(value);
}

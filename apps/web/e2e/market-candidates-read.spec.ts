import { expect, test } from "@playwright/test";
import {
  captureState,
  accessibleState,
  deferred,
  ID,
  keyboardActivate,
  matrix,
  observeToasts,
  prepareCopy,
  toastWasSeen,
  revision,
  setup,
} from "./support/market-candidates-fixtures";
// 构建产物的 API 前缀取决于 .env.production 是否在场（CI 无该文件），两条形态都要命中。
const apiRoute = (path: string) =>
  new RegExp(
    `/(?:api/)?${path
      .replace(/^\//, "")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\?.*)?$`,
  );
for (const cell of matrix) {
  test.describe(cell.label, () => {
    test.afterEach(async ({ page }, info) => {
      await accessibleState(page);
      const screenshot = info.outputPath("state.png");
      await page.screenshot({ path: screenshot, fullPage: true });
      await info.attach("original-size-state", { path: screenshot, contentType: "image/png" });
    });
    test("V01 no document is not an empty result, no implicit generation", async ({ page }) => {
      const h = await setup(page, cell);
      h.state.latest = { status: "NOT_ANALYZED", result: null };
      await h.open();
      await captureState(page, cell, "panel-open");
      await expect(h.button("not-analyzed")).toBeVisible();
      await captureState(page, cell, "not-analyzed");
      expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(0);
      await h.button("close").focus();
      await page.keyboard.press("Tab");
      await expect(page.getByTestId("mc-panel")).toContainText(
        cell.lang === "zh-CN" ? "尚未生成" : "No market",
      );
      h.check();
    });
    test("V02 independent combinations in the same country remain separate", async ({ page }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      await expect(page.getByTestId("mc-card")).toHaveCount(2);
      await expect(page.getByTestId("mc-card").first()).toContainText("Battery cells");
      await expect(page.getByTestId("mc-card").nth(1)).toContainText("Roof projects");
      h.check();
    });
    test("V03 two countries and nulls are independent, no named decision maker", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      const a = page.getByTestId("mc-card").first();
      await expect(a).toContainText("FR");
      await expect(a).toContainText(cell.lang === "zh-CN" ? "未知" : "Unknown");
      await expect(a).toContainText("Distributor hypothesis");
      h.check();
    });
    test("V04 conflict, condition and gaps remain visible and scoped", async ({ page }) => {
      const h = await setup(page, cell);
      const rev = revision();
      const firstSource = rev.document.basisSnapshot.sources[0]!;
      const secondSource = {
        ...structuredClone(firstSource),
        kind: "CLAIM" as const,
        sourceId: "99999999-9999-4999-8999-999999999999",
        key: "CLAIM:99999999-9999-4999-8999-999999999999",
        status: "APPROVED",
        parentId: firstSource.sourceId,
        parentContentHash: firstSource.contentHash,
        digest: "c".repeat(64),
        contentHash: "c".repeat(64),
        position: { seq: 2, page: 2, section: "Delivery review", quoteStart: 0, quoteEnd: 40 },
      };
      rev.document.basisSnapshot.sources.push(secondSource);
      rev.basisAvailability.push({ key: secondSource.key, status: "CURRENT", reason: "MATCHED" });
      rev.document.candidates[0]!.proposal.support = [
        {
          text: "7-day delivery / 7天交期",
          knowledgeState: "SELLER_ASSERTION",
          basisKeys: [firstSource.key],
          impact: "Applies only to this combination / 仅此组合",
        },
      ];
      rev.document.candidates[0]!.proposal.counterEvidence = [
        {
          text: "30-day delivery / 30天交期，与7天交期冲突",
          knowledgeState: "CONFLICT",
          basisKeys: [secondSource.key],
          impact: "Applies only to this combination / 仅此组合",
        },
      ];
      h.state.latest = { status: "AVAILABLE", result: rev };
      await h.open();
      await captureState(page, cell, "panel-open");
      await page.getByTestId("mc-details").first().click();
      await expect(page.getByTestId("mc-detail")).toContainText("交期冲突");
      await expect(page.getByTestId("mc-detail")).toContainText("需要认证");
      await expect(page.getByTestId("mc-detail")).toContainText("买方需求未知");
      await captureState(
        page,
        cell,
        "conflict-detail",
        page.getByTestId("mc-detail").getByRole("heading", {
          name: cell.lang === "zh-CN" ? "反证" : "Counter-evidence",
          exact: true,
        }),
      );
      const detail = h.button("detail");
      for (const [index, text, key] of [
        [1, "7-day delivery / 7天交期", firstSource.key],
        [2, "30-day delivery / 30天交期，与7天交期冲突", secondSource.key],
      ] as const) {
        const statement = detail
          .locator(".mc-statement")
          .filter({ has: page.getByText(text, { exact: true }) });
        await expect(statement).toHaveCount(1);
        await statement.locator("summary").click();
        await expect(statement).toContainText(key);
        await captureState(page, cell, `conflict-side-${index}`, statement);
      }
      for (let index = 0; index < 2; index++) {
        const source = detail.locator(".mc-source").nth(index);
        await source.locator("summary").click();
        await expect(source).toContainText(index === 0 ? firstSource.key : secondSource.key);
        await captureState(page, cell, `conflict-source-${index + 1}`, source);
      }
      await expect(page.getByTestId("mc-feedback").nth(1)).toBeEnabled();
      h.check();
    });
    test("V05 counter-evidence, unavailable sources and negative recommendation remain honest", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      const rev = revision();
      rev.basisAvailability[0]!.status = "UNAVAILABLE";
      rev.document.candidates[0]!.proposal.recommendation.status = "NOT_RECOMMENDED";
      h.state.latest = { status: "AVAILABLE", result: rev };
      await h.open();
      await captureState(page, cell, "panel-open");
      await page.getByTestId("mc-details").first().click();
      await expect(page.getByTestId("mc-detail")).toContainText("交期冲突");
      await expect(page.getByTestId("mc-detail")).toContainText(
        cell.lang === "zh-CN" ? "依据暂不可访问" : "Basis unavailable",
      );
      await expect(page.getByTestId("mc-detail").locator("a")).toHaveCount(0);
      await captureState(
        page,
        cell,
        "source-availability",
        page.getByTestId("mc-detail").getByRole("heading", {
          name: cell.lang === "zh-CN" ? "反证" : "Counter-evidence",
          exact: true,
        }),
      );
      h.check();
    });
    test("V11 legal empty and malformed documents are not conflated", async ({ page }) => {
      const h = await setup(page, cell);
      const rev = revision();
      rev.document.candidates = [];
      rev.document.generationOutcome = "COMPLETED_EMPTY";
      h.state.latest = { status: "AVAILABLE", result: rev };
      await h.open();
      await captureState(page, cell, "panel-open");
      await expect(h.button("empty")).toBeVisible();
      await captureState(page, cell, "empty");
      h.state.malformed = true;
      await h.button("refresh").click();
      await expect(h.button("error")).toBeVisible();
      await captureState(page, cell, "error");
      await expect(h.button("empty")).toHaveCount(0);
      await captureState(page, cell, "empty");
      h.check();
    });
    test("V15 paginated historical revision is read-only and source refusals clear it", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      h.state.latest = { status: "AVAILABLE", result: revision(2) };
      await h.open();
      await captureState(page, cell, "panel-open");
      await h.button("history").click();
      await expect(h.button("revision-2")).toBeVisible();
      await h.button("history-more").click();
      await expect(h.button("revision-1")).toBeVisible();
      await captureState(page, cell, "revision-1");
      await h.button("revision-1").click();
      await expect(h.button("historical")).toBeVisible();
      await captureState(page, cell, "historical");
      await expect(page.getByTestId("mc-feedback")).toHaveCount(0);
      await h.button("current").click();
      await expect(h.button("historical")).toHaveCount(0);
      await captureState(page, cell, "historical");
      expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(0);
      const gate = deferred();
      h.state.latestWait = gate.promise;
      const response = page.waitForResponse((value) =>
        value.url().endsWith(`/companies/${ID.company}/market-candidate-sets/latest`),
      );
      await h.button("refresh").click();
      const loading = page
        .getByTestId("mc-panel")
        .getByText(cell.lang === "zh-CN" ? "正在读取候选…" : "Loading candidates…", {
          exact: true,
        });
      await expect(loading).toBeVisible();
      await h.button("revision-1").click();
      await expect(h.button("historical")).toBeVisible();
      gate.resolve();
      await response;
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
      await expect(loading).toHaveCount(0);
      await expect(h.button("refresh")).toBeEnabled();
      await expect(h.button("historical")).toBeVisible();
      await expect(h.button("revision-label")).toContainText("1");
      await captureState(page, cell, "latest-history-loading-released");
      h.check();
    });
    test("V16 read refusal and company context switch do not revive old data", async ({ page }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      await expect(page.getByTestId("mc-card")).toHaveCount(2);
      await h.button("prepare").click();
      await expect(h.button("phase")).toHaveAttribute("data-phase", "PREPARED");
      const references = await page.evaluate(() =>
        sessionStorage.getItem("gainos-market-candidate-pending-v1"),
      );
      h.state.deny = "read";
      await h.button("refresh").click();
      await expect(h.button("error")).toBeVisible();
      await captureState(page, cell, "error");
      await expect(page.getByTestId("mc-card")).toHaveCount(0);
      await expect(h.button("phase")).toHaveCount(0);
      await expect(h.button("execute")).toHaveCount(0);
      await expect(h.button("query")).toBeVisible();
      expect(
        await page.evaluate(() => sessionStorage.getItem("gainos-market-candidate-pending-v1")),
      ).toBe(references);
      expect(h.requests.filter((request) => request.path.endsWith("/execute"))).toHaveLength(0);
      await captureState(page, cell, "read-denial-generation-withdrawn");
      await h.button("close").click();
      h.state.deny = "";
      await h.open(true);
      await captureState(page, cell, "panel-open");
      await expect(h.button("not-analyzed")).toBeVisible();
      await captureState(page, cell, "not-analyzed");
      await expect(page.getByTestId("mc-card")).toHaveCount(0);
      h.check();
    });
    test("V15 latest scope refusal invalidates a late historical response", async ({ page }) => {
      const h = await setup(page, cell);
      h.state.latest = { status: "AVAILABLE", result: revision(2) };
      await h.open();
      await captureState(page, cell, "panel-open");
      await h.button("history").click();
      const a = deferred(),
        b = deferred();
      h.state.latestWait = a.promise;
      h.state.revisionWait = b.promise;
      await h.button("refresh").click();
      const late = page.waitForResponse((response) => response.url().endsWith("/revisions/2"));
      await h.button("revision-2").click();
      await expect
        .poll(() => h.requests.some((request) => request.path.endsWith("/revisions/2")))
        .toBe(true);
      h.state.deny = "read";
      a.resolve();
      await expect(h.button("error")).toBeVisible();
      await captureState(page, cell, "error");
      b.resolve();
      await late;
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
      await expect(page.getByTestId("mc-card")).toHaveCount(0);
      h.check();
    });

    test("V01 missing basis refusal stays separate from no document", async ({ page }) => {
      const h = await setup(page, cell);
      h.state.latest = { status: "NOT_ANALYZED", result: null };
      await h.open();
      await captureState(page, cell, "panel-open");
      expect(h.requests.filter((request) => request.method === "POST")).toHaveLength(0);
      await expect(h.button("not-analyzed")).toBeVisible();
      await expect(page.getByTestId("mc-panel").locator("select")).toHaveCount(0);
      for (const scenario of ["NO_OFFERINGS", "NO_APPROVED_CLAIMS"] as const) {
        h.state.prepareBasis = scenario;
        const code = scenario === "NO_OFFERINGS" ? "VALIDATION_ERROR" : "NO_APPROVED_CLAIMS";
        const responsePromise = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().endsWith(`/companies/${ID.company}/market-candidate-generations`),
        );
        await observeToasts(page);
        await h.button("prepare").click();
        const response = await responsePromise,
          body = await response.json();
        expect(response.status()).toBe(400);
        expect(body).toMatchObject({ error: { code } });
        const copy = prepareCopy(code, cell.lang);
        await expect(h.button("error")).toContainText(copy.title);
        await expect(h.button("error-why")).toHaveText(copy.why);
        await expect(h.button("error-next")).toHaveText(copy.next);
        expect(await toastWasSeen(page)).toBe(false);
        await expect(h.button("not-analyzed")).toBeVisible();
        await expect(h.button("empty")).toHaveCount(0);
        await expect(h.button("phase")).toHaveCount(0);
        const destination = scenario === "NO_OFFERINGS" ? "facts" : "documents";
        const recoveryTrigger = h.button(`recover-${destination}`);
        await expect(recoveryTrigger).toBeVisible();
        const network: Array<{ method: string; path: string }> = [];
        page.on("request", (request) => {
          const url = new URL(request.url());
          if (url.origin === "http://127.0.0.1:4173") {
            network.push({ method: request.method(), path: url.pathname });
          }
        });
        const expectedRecoveryPath = destination === "facts" ? "/claims" : "/seller-documents";
        const recoveryRequestPromise = page.waitForRequest((request) =>
          request.url().includes(expectedRecoveryPath),
        );
        await keyboardActivate(page, cell, `recover-${destination}`, recoveryTrigger);
        const recoveryPanel = destination === "facts" ? ".cp__facts-panel" : ".cp__docs-panel";
        await expect(page.locator(recoveryPanel)).toBeVisible();
        await expect(page.locator(recoveryPanel)).toHaveAttribute("data-readonly", "true");
        if (destination === "facts") {
          await expect(page.locator(".cp__manual-bar")).toHaveCount(0);
          await expect(page.locator(".cp__claim-bar")).toHaveCount(0);
          await expect(page.locator(".cp__claim-check")).toHaveCount(0);
        } else {
          await expect(page.locator(".cp__docs-panel input[type=file]")).toHaveCount(0);
          await expect(page.locator(".cp__docs-actions")).toHaveCount(0);
        }
        const recoveryRequest = await recoveryRequestPromise;
        expect(recoveryRequest.method()).toBe("GET");
        await page.waitForLoadState("networkidle");
        const recoveryCalls = network;
        expect(recoveryCalls.every((request) => request.method === "GET")).toBe(true);
        expect(
          recoveryCalls.some((request) => request.path.includes(expectedRecoveryPath)),
        ).toBe(true);
        await expect(page.locator('[role="dialog"]:visible')).toHaveCount(1);
        await expect(page.getByTestId("mc-panel")).toBeHidden();
        await expect(page.getByTestId("mc-panel").locator("xpath=..")).toHaveAttribute(
          "aria-hidden",
          "true",
        );
        await page.keyboard.press("Escape");
        await expect(page.locator(recoveryPanel)).toHaveCount(0);
        await expect(page.getByTestId("mc-panel")).toBeVisible();
        await expect(recoveryTrigger).toBeFocused();
        await expect(page.locator(".ant-message-notice")).toHaveCount(0, { timeout: 10000 });
        expect(h.requests.filter((request) => request.path.endsWith("/execute"))).toHaveLength(0);
        expect(h.state.executionDispatches).toBe(0);
        const posts = h.requests.filter((request) => request.method === "POST");
        expect(posts.at(-1)!.body).toEqual({ intentId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
        await captureState(page, cell, `missing-basis-refusal-${scenario}`, h.button("error"));
        console.log(
          JSON.stringify({
            kind: "PRIVATE_V01_BASIS_REFUSAL",
            cell: cell.label,
            scenario,
            fixed_contract_stage: "INITIAL_PREPARE_NEW_ALLOCATION",
            response_status: response.status(),
            response: body,
            displayed_error: await h.button("error").textContent(),
            prepare: posts.at(-1),
            basis_witness: {
              effective_offerings: scenario === "NO_OFFERINGS" ? 0 : 1,
              approved_claims: 0,
            },
            execution_dispatches: h.state.executionDispatches,
            mock_only: true,
          }),
        );
      }
      expect(h.requests.filter((request) => request.method === "POST")).toHaveLength(2);
      await h.button("close").click();
      await expect(page.locator(".cp__more summary").first()).toBeFocused();
      h.check();
    });
    test("V01b late facts response for the old company never writes the current company", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      h.state.prepareBasis = "NO_APPROVED_CLAIMS";
      await h.button("prepare").click();
      await expect(h.button("recover-facts")).toBeVisible();
      const claimsGate = deferred(),
        overviewGate = deferred();
      const claim = (id: string, statement: string) => ({
        id,
        companyId: ID.company,
        type: "company_fact",
        statement,
        status: "NEEDS_REVIEW",
        version: 1,
      });
      const overview = (id: string, name: string, summary: string) => ({
        id,
        name,
        summary,
      });
      const fulfill = (route: import("@playwright/test").Route, data: unknown) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data }),
        });
      await page.route(apiRoute(`/companies/${ID.company}/claims`), async (route) => {
        await claimsGate.promise;
        await fulfill(route, [claim("a-claim", "A-ONLY-CLAIM")]);
      });
      await page.route(apiRoute(`/companies/${ID.company}`), async (route) => {
        await overviewGate.promise;
        await fulfill(route, overview(ID.company, "Synthetic Seller", "A-OVERVIEW"));
      });
      for (const id of [ID.company, ID.second]) {
        await page.route(apiRoute(`/companies/${id}/completeness`), (route) =>
          fulfill(route, { status: "OK", approvedClaims: 0, pendingClaims: 1, offerings: 0, conflictsOpen: 0 }),
        );
        await page.route(apiRoute(`/companies/${id}/offerings`), (route) => fulfill(route, []));
        await page.route(apiRoute(`/companies/${id}/conflicts`), (route) => fulfill(route, []));
      }
      await page.route(apiRoute(`/companies/${ID.second}/claims`), (route) =>
        fulfill(route, [claim("b-claim", "B-ONLY-CLAIM")]),
      );
      await page.route(apiRoute(`/companies/${ID.second}`), (route) =>
        fulfill(route, overview(ID.second, "Second Seller", "B-OVERVIEW")),
      );
      await h.button("recover-facts").click();
      await expect(page.locator(".cp__facts-panel")).toBeVisible();
      await page.locator(".cp__facts-panel .cp__modal-x").click();
      await expect(page.locator(".cp__facts-panel")).toHaveCount(0);
      await h.button("close").click();
      await expect(page.getByTestId("mc-panel")).toHaveCount(0);
      const second = page.locator(".cp__table tbody tr").nth(1);
      await second
        .getByRole("button", {
          name: cell.lang === "zh-CN" ? "查看档案" : "View profile",
          exact: true,
        })
        .click();
      await expect(page.locator(".cp__facts-panel")).toBeVisible();
      await expect(page.locator(".cp__facts-panel")).toContainText("B-OVERVIEW");
      await expect(page.locator(".cp__facts-panel")).toContainText("B-ONLY-CLAIM");
      claimsGate.resolve();
      overviewGate.resolve();
      await page.waitForTimeout(300);
      await expect(page.locator(".cp__facts-panel")).toContainText("B-OVERVIEW");
      await expect(page.locator(".cp__facts-panel")).toContainText("B-ONLY-CLAIM");
      await expect(page.locator(".cp__facts-panel")).not.toContainText("A-OVERVIEW");
      await expect(page.locator(".cp__facts-panel")).not.toContainText("A-ONLY-CLAIM");
      h.check();
    });
    test("V01c late document search never writes the current company or query", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      const bGate = deferred(),
        solarGate = deferred();
      const hit = (text: string) => ({
        documentId: `${ID.company}-doc`,
        filename: `${text}.pdf`,
        seq: 1,
        text,
        score: 1,
      });
      const fulfill = (route: import("@playwright/test").Route, data: unknown) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data }),
        });
      await page.route(apiRoute(`/companies/${ID.second}/seller-documents/search`), async (route) => {
        await bGate.promise;
        await fulfill(route, [hit("B-PUMP-ONLY")]);
      });
      await page.route(apiRoute(`/companies/${ID.company}/seller-documents/search`), async (route) => {
        const q = new URL(route.request().url()).searchParams.get("q");
        if (q === "solar") await solarGate.promise;
        await fulfill(route, [hit(q === "solar" ? "A-SOLAR-ONLY" : "A-WIND-ONLY")]);
      });
      const openDocs = async (rowIndex: number, query: string) => {
        const row = page.locator(".cp__table tbody tr").nth(rowIndex);
        await row.locator("summary").click();
        await row
          .getByRole("button", {
            name: cell.lang === "zh-CN" ? "资料库" : "Documents",
            exact: true,
          })
          .click();
        await expect(page.locator(".cp__docs-panel")).toBeVisible();
        const input = page.locator(".cp__docs-panel input[type=search]");
        await input.fill(query);
        await page
          .locator(".cp__docs-panel")
          .getByRole("button", {
            name: cell.lang === "zh-CN" ? "在资料里检索" : "Search documents",
            exact: true,
          })
          .click();
        return input;
      };
      await openDocs(1, "pump");
      await page.locator(".cp__docs-panel .cp__modal-x").click();
      await expect(page.locator(".cp__docs-panel")).toHaveCount(0);
      const input = await openDocs(0, "solar");
      await input.fill("wind");
      solarGate.resolve();
      await page.waitForTimeout(300);
      await expect(page.locator(".cp__docs-hits")).not.toContainText("A-SOLAR-ONLY");
      await page
        .locator(".cp__docs-panel")
        .getByRole("button", {
          name: cell.lang === "zh-CN" ? "在资料里检索" : "Search documents",
          exact: true,
        })
        .click();
      await expect(page.locator(".cp__docs-hits")).toContainText("A-WIND-ONLY");
      bGate.resolve();
      await page.waitForTimeout(300);
      await expect(page.locator(".cp__docs-hits")).toContainText("A-WIND-ONLY");
      await expect(page.locator(".cp__docs-hits")).not.toContainText("B-PUMP-ONLY");
    });
    test("V03 both distinct countries and independent nulls are rendered", async ({ page }) => {
      const h = await setup(page, cell);
      const rev = revision();
      rev.document.candidates[0]!.proposal.projectCountry = "US";
      rev.document.candidates[1]!.proposal.buyerOrganizationCountry = null;
      rev.document.candidates[1]!.proposal.supplyOrCapability.description = "Modules / 组件";
      h.state.latest = { status: "AVAILABLE", result: rev };
      await h.open();
      await captureState(page, cell, "panel-open");
      await expect(page.getByTestId("mc-card").first()).toContainText("FR");
      await expect(page.getByTestId("mc-card").first()).toContainText("US");
      await expect(page.getByTestId("mc-card").nth(1)).toContainText(
        cell.lang === "zh-CN" ? "未知" : "Unknown",
      );
      await expect(page.getByTestId("mc-card").nth(1)).toContainText("组件");
      const second = page.getByTestId("mc-card").nth(1);
      for (const label of [
        cell.lang === "zh-CN" ? "采购组织所在国" : "Buyer organization country",
        cell.lang === "zh-CN" ? "项目所在国" : "Project country",
      ]) {
        const value = second
          .locator("dl > div")
          .filter({ has: page.getByText(label, { exact: true }) })
          .locator("dd");
        await expect(value).toHaveText(cell.lang === "zh-CN" ? "未知" : "Unknown");
      }
      await captureState(page, cell, "second-card-null-countries", second);
      h.check();
    });
    test("V15 source refusal during historical read removes old content", async ({ page }) => {
      const h = await setup(page, cell);
      h.state.latest = { status: "AVAILABLE", result: revision(2) };
      await h.open();
      await captureState(page, cell, "panel-open");
      await h.button("history").click();
      h.state.noHistory = true;
      await h.button("revision-2").click();
      await expect(h.button("error")).toBeVisible();
      await captureState(page, cell, "error");
      await expect(page.getByTestId("mc-card")).toHaveCount(0);
      await expect(page.getByTestId("mc-detail")).toHaveCount(0);
      h.check();
    });
    test("V16 closing old context rejects its late data after opening another company", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      const gate = deferred();
      h.state.latestWait = gate.promise;
      await h.button("refresh").click();
      await h.button("close").click();
      await h.open(true);
      await captureState(page, cell, "panel-open");
      await expect(h.button("not-analyzed")).toBeVisible();
      await captureState(page, cell, "not-analyzed");
      gate.resolve();
      await expect(page.getByTestId("mc-card")).toHaveCount(0);
      await expect(page.getByTestId("mc-panel")).toContainText("Second Seller");
      h.check();
    });
    test("V16 a different workspace cannot restore another context operation", async ({ page }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      await h.button("prepare").click();
      await expect(h.button("query")).toBeVisible();
      await h.button("close").click();
      h.backend.session.workspace.id = "second-workspace";
      h.backend.session.workspaces = [
        { id: "second-workspace", name: "Other workspace", role: "member" },
      ];
      await page.reload();
      await h.open();
      await captureState(page, cell, "panel-open");
      await expect(h.button("query")).toHaveCount(0);
      expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(1);
      h.check();
    });
    test("V16 unauthenticated reload cannot display candidate content", async ({ page }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      h.backend.set(
        "GET",
        "/auth/session",
        async ({ route }: { route: import("@playwright/test").Route }) => {
          await route.fulfill({
            status: 401,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "AUTH_REQUIRED" } }),
          });
          return true;
        },
      );
      await page.reload();
      await page.waitForURL(/\/auth\/login/);
      await expect(page.getByTestId("mc-panel")).toHaveCount(0);
      await expect(page.getByTestId("mc-card")).toHaveCount(0);
      h.check();
    });

    test("V15 detail close returns focus to the exact second-card details trigger", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      const trigger = page.getByTestId("mc-details").nth(1);
      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("mc-detail")).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(page.getByTestId("mc-detail").getByRole("button").first()).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      expect(
        await page.evaluate(
          () => document.activeElement?.closest('[data-testid="mc-panel"]') !== null,
        ),
      ).toBe(true);
      await page.getByTestId("mc-detail").getByRole("button").click();
      await expect(page.getByTestId("mc-detail")).toHaveCount(0);
      await expect(trigger).toBeFocused();
      h.check();
    });
  });
}

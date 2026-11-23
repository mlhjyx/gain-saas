import type { components } from "@gain-saas/engine-client";
import { expect, test } from "@playwright/test";
import {
  captureState,
  accessibleState,
  deferred,
  matrix,
  setup,
  keyboardActivate,
  keyboardSelect,
  keyboardType,
  safeErrorCopy,
} from "./support/market-candidates-fixtures";
for (const cell of matrix)
  test.describe(cell.label, () => {
    test.afterEach(async ({ page }, info) => {
      await accessibleState(page);
      const screenshot = info.outputPath("state.png");
      await page.screenshot({ path: screenshot, fullPage: true });
      await info.attach("original-size-state", { path: screenshot, contentType: "image/png" });
    });
    test("V12 each feedback action records a specific revision and rereads authority", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      for (const action of ["CONFIRM", "KEEP_PENDING", "REJECT", "CORRECT"]) {
        await keyboardActivate(
          page,
          cell,
          "open-feedback",
          page.getByTestId("mc-feedback").first(),
        );
        await keyboardSelect(page, cell, action);
        if (action === "CORRECT")
          await keyboardType(
            page,
            cell,
            "correction-application",
            h.button("correction-application"),
            "A specific changed application",
          );
        await keyboardType(page, cell, "reason", h.button("reason"), "Synthetic reason");
        await expect(h.button("feedback-dialog")).toBeVisible();
        await captureState(page, cell, `feedback-dialog-open-${action}`);
        await keyboardActivate(page, cell, "save-feedback", h.button("feedback-save"));
        await expect(h.button("feedback-dialog")).toHaveCount(0);
        await captureState(page, cell, "feedback-dialog-closed");
        await expect(h.button("notice")).toBeVisible();
        if ((await h.button("receipt").getAttribute("open")) === null)
          await keyboardActivate(
            page,
            cell,
            "open-receipt",
            h.button("receipt").locator("summary"),
          );
        const overlay =
          cell.lang === "zh-CN"
            ? "用户纠正覆盖层，原提议未变"
            : "User correction overlay; original proposal unchanged";
        if (action === "CORRECT") await expect(h.button("receipt")).toContainText(overlay);
        else await expect(h.button("receipt")).not.toContainText(overlay);
        await captureState(page, cell, `feedback-receipt-${action}`, h.button("receipt"));
      }
      const posts = h.requests.filter((r) => r.path.endsWith("/feedback"));
      expect(posts).toHaveLength(4);
      for (const r of posts) {
        expect(r.key).toMatch(/^[a-f0-9-]{36}$/);
        expect(r.body).toHaveProperty("expectedRevision");
      }
      h.check();
    });
    test("V13 no-op correction is rejected locally; unsaved input survives leave cancel", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      await page.getByTestId("mc-feedback").first().click();
      await h.button("feedback-action").selectOption("CORRECT");
      await h.button("feedback-save").click();
      await expect(h.button("feedback-validation")).toBeVisible();
      expect(h.requests.filter((r) => r.path.endsWith("/feedback"))).toHaveLength(0);
      await h.button("correction-application").fill("Changed application");
      page.once("dialog", (d) => d.dismiss());
      await h.button("feedback-cancel").click();
      await expect(h.button("correction-application")).toHaveValue("Changed application");
      await h.button("feedback-save").click();
      await expect(h.button("feedback-dialog")).toHaveCount(0);
      await captureState(page, cell, "feedback-dialog-closed");
      h.check();
    });
    test("V14 unknown accepted response replays the original key without regressing newer current", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      await page.getByTestId("mc-feedback").first().click();
      await h.button("reason").fill("Keep this draft");
      h.state.loseFeedback = true;
      await h.button("feedback-save").click();
      await expect(h.button("feedback-error")).toBeVisible();
      await captureState(page, cell, "feedback-error");
      expect(h.state.feedbackWrites).toBe(1);
      h.advanceCurrent(4);
      await h.button("feedback-save").click();
      await expect(h.button("feedback-dialog")).toHaveCount(0);
      await captureState(page, cell, "feedback-dialog-closed");
      await expect(h.button("revision-label")).toContainText("4");
      const posts = h.requests.filter((r) => r.path.endsWith("/feedback"));
      expect(posts).toHaveLength(2);
      expect(posts[0]!.key).toBe(posts[1]!.key);
      expect(posts[0]!.body).toEqual(posts[1]!.body);
      expect(h.state.feedbackWrites).toBe(1);
      expect(h.state.feedbackReplays).toBe(1);
      h.check();
    });
    test("V14 Escape cannot discard an in-flight frozen feedback request", async ({ page }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      await page.getByTestId("mc-feedback").first().click();
      await h.button("reason").fill("Keep until response");
      const gate = deferred();
      h.state.feedbackWait = gate.promise;
      await h.button("feedback-save").click();
      await expect(h.button("feedback-save")).toBeDisabled();
      const busyDialog = h.button("feedback-dialog");
      await page.locator(".mc-feedback-mask").click({ position: { x: 2, y: 2 } });
      await expect
        .poll(() => busyDialog.evaluate((el) => el.contains(document.activeElement)))
        .toBe(true);
      await page.keyboard.press("Tab");
      expect(await busyDialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Shift+Tab");
      expect(await busyDialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      page.once("dialog", (d) => d.accept());
      await page.keyboard.press("Escape");
      await expect(busyDialog).toBeVisible();
      await captureState(page, cell, "feedback-dialog-open-inflight");
      gate.resolve();
      await expect(h.button("feedback-dialog")).toHaveCount(0);
      await captureState(page, cell, "feedback-dialog-closed");
      expect(h.requests.filter((r) => r.path.endsWith("/feedback"))).toHaveLength(1);
      h.check();
    });

    test("V12 omitted reason is read back without invention and key changes only for a new feedback", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      await page.getByTestId("mc-feedback").first().click();
      const initialResponsePromise = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" && response.url().endsWith("/feedback"),
      );
      await h.button("feedback-save").click();
      const initialResponse = await initialResponsePromise;
      await expect(h.button("feedback-dialog")).toHaveCount(0);
      await captureState(page, cell, "feedback-dialog-closed");
      await h.button("receipt").locator("summary").click();
      await expect(h.button("receipt")).toContainText(
        cell.lang === "zh-CN" ? "未提供" : "Not provided",
      );
      const original = h.requests.find((request) => request.path.endsWith("/feedback"))!;
      const originalBody =
        original.body as components["schemas"]["MarketCandidateFeedbackInputDto"];
      for (const reason of [null, "", " \t\n", "\u00a0"]) {
        const replay = await page.evaluate(
          async ({ url, key, body, reason }) => {
            const response = await fetch(url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "idempotency-key": key,
              },
              body: JSON.stringify({ ...body, reason }),
            });
            return { status: response.status, body: await response.json() };
          },
          { url: initialResponse.url(), key: original.key!, body: originalBody, reason },
        );
        expect(replay.status).toBe(200);
        expect(replay.body).toMatchObject({
          data: { replayed: true, reason: null, recordedRevision: 2 },
        });
        expect(h.state.feedbackWrites).toBe(1);
        console.log(
          JSON.stringify({
            kind: "PRIVATE_REASON_BLANK_EQUIVALENCE",
            cell: cell.label,
            submitted_reason: reason,
            actual: replay,
            mock_only: true,
          }),
        );
      }
      expect(h.state.feedbackReplays).toBe(4);
      const tooLong = await page.evaluate(
        async ({ url, key, body }) => {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": key,
            },
            body: JSON.stringify({ ...body, reason: " ".repeat(2001) }),
          });
          return { status: response.status, body: await response.json() };
        },
        { url: initialResponse.url(), key: original.key!, body: originalBody },
      );
      expect(tooLong.status).toBe(400);
      expect(tooLong.body).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
      expect(h.state.feedbackWrites).toBe(1);
      expect(h.state.feedbackReplays).toBe(4);
      console.log(
        JSON.stringify({
          kind: "PRIVATE_REASON_LENGTH_BEFORE_NORMALIZATION",
          cell: cell.label,
          actual: tooLong,
          mock_only: true,
        }),
      );
      let visualCases = 0;
      for (const rawReason of [
        "  Explicit later feedback  ",
        "第一行\nSecond  line longtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtokenlongtoken\n",
        "\tPreserve tabs and spaces \n",
        " \t\n",
        "\u00a0",
      ]) {
        await page.getByTestId("mc-feedback").first().click();
        await h.button("reason").fill(rawReason);
        const browserValue = await h.button("reason").inputValue();
        await expect(h.button("feedback-dialog")).toBeVisible();
        await captureState(page, cell, "feedback-dialog-open-verbatim-reason");
        const responsePromise = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" && response.url().endsWith("/feedback"),
        );
        await h.button("feedback-save").click();
        const response = await responsePromise;
        const responseBody = await response.json();
        await expect(h.button("feedback-dialog")).toHaveCount(0);
        await captureState(page, cell, "feedback-dialog-closed");
        const last = h.requests.filter((request) => request.path.endsWith("/feedback")).at(-1)!;
        const expectedReason = browserValue.trim() ? browserValue : null;
        if (expectedReason === null) expect(last.body).not.toHaveProperty("reason");
        else expect(last.body).toHaveProperty("reason", browserValue);
        expect(responseBody).toMatchObject({ data: { reason: expectedReason } });
        if ((await h.button("receipt").getAttribute("open")) === null)
          await h.button("receipt").locator("summary").click();
        if (expectedReason === null)
          await expect(h.button("receipt")).toContainText(
            cell.lang === "zh-CN" ? "未提供" : "Not provided",
          );
        else expect(await h.button("receipt").textContent()).toContain(browserValue);
        await captureState(
          page,
          cell,
          expectedReason === null ? "blank-reason-missing" : "provided-reason-verbatim",
          h.button("receipt"),
        );
        if (browserValue.startsWith("第一行")) {
          visualCases++;
          const paragraph = h.button("receipt").locator("p").nth(1);
          const geometry = await paragraph.evaluate((element) => {
            const node = [...element.childNodes].find(
              (value) => value.nodeType === Node.TEXT_NODE && value.textContent?.includes("第一行"),
            );
            if (!node) throw new Error("Actual reason text node missing");
            const text = node.textContent!;
            const first = document.createRange(),
              second = document.createRange();
            first.setStart(node, text.indexOf("第一行"));
            first.setEnd(node, text.indexOf("第一行") + 1);
            second.setStart(node, text.indexOf("Second"));
            second.setEnd(node, text.indexOf("Second") + 1);
            const style = getComputedStyle(element);
            return {
              whiteSpace: style.whiteSpace,
              overflowWrap: style.overflowWrap,
              firstTop: first.getBoundingClientRect().top,
              secondTop: second.getBoundingClientRect().top,
              width: element.clientWidth,
              scroll: element.scrollWidth,
            };
          });
          console.log(
            JSON.stringify({ kind: "PRIVATE_REASON_VISUAL", cell: cell.label, geometry }),
          );
          expect(geometry.whiteSpace).toBe("pre-wrap");
          expect(geometry.secondTop).toBeGreaterThan(geometry.firstTop);
          expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
          await captureState(page, cell, "reason-visible-newlines-and-long-text", paragraph);
        }
        console.log(
          JSON.stringify({
            kind:
              expectedReason === null
                ? "PRIVATE_REASON_BLANK_NORMALIZED"
                : "PRIVATE_REASON_VERBATIM",
            cell: cell.label,
            browser_value: browserValue,
            request: last,
            response: responseBody,
            mock_only: true,
          }),
        );
      }
      const posts = h.requests.filter(
        (request) =>
          request.path.endsWith("/feedback") &&
          (request === original || request.key !== original.key),
      );
      expect(visualCases).toBe(1);
      expect(posts).toHaveLength(6);
      expect(h.state.feedbackWrites).toBe(6);
      expect(h.state.feedbackReplays).toBe(4);
      expect(posts[0]!.body).not.toHaveProperty("reason");
      expect(posts[0]!.key).not.toBe(posts[1]!.key);
      expect((posts[1]!.body as { expectedRevision: number }).expectedRevision).toBe(2);
      h.check();
    });
    test("V13 substantive correction and single rejection preserve the independent combination", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      const initial = h.state.latest.result!;
      initial.document.candidates[0]!.proposal.buyerOrganizationCountry = "DE";
      initial.document.candidates[0]!.proposal.projectCountry = "FR";
      initial.document.candidates[1]!.proposal.buyerOrganizationCountry = null;
      initial.document.candidates[1]!.proposal.projectCountry = null;
      await h.open();
      await captureState(page, cell, "panel-open");
      await page.getByTestId("mc-feedback").first().click();
      await h.button("feedback-action").selectOption("CORRECT");
      await h.button("correction-application").fill("Changed application");
      await h.button("correction-buyerOrganizationCountry").fill("");
      await h.button("correction-projectCountry").fill("ES");
      await expect(h.button("feedback-dialog")).toBeVisible();
      await captureState(page, cell, "feedback-dialog-open-country-correction");
      await h.button("feedback-save").click();
      await expect(h.button("feedback-dialog")).toHaveCount(0);
      await captureState(page, cell, "feedback-dialog-closed");
      await expect(page.getByTestId("mc-card").first()).toContainText("Changed application");
      await expect(page.getByTestId("mc-card").first()).toContainText(
        cell.lang === "zh-CN" ? "待复核" : "reassessment",
      );
      await expect(page.getByTestId("mc-card").nth(1)).toContainText("Roof projects");
      await expect(page.getByTestId("mc-card").first()).toContainText("ES");
      await expect(page.getByTestId("mc-card").first()).toContainText(
        cell.lang === "zh-CN" ? "未知" : "Unknown",
      );
      await page.getByTestId("mc-details").first().click();
      await expect(h.button("original-buyer-country")).toHaveText("DE");
      await expect(h.button("original-project-country")).toHaveText("FR");
      await captureState(page, cell, "original-country-comparison", h.button("original-countries"));
      await h.button("detail").getByRole("button").click();
      await page.getByTestId("mc-details").nth(1).click();
      for (const field of ["original-buyer-country", "original-project-country"])
        await expect(h.button(field)).toHaveText(cell.lang === "zh-CN" ? "未知" : "Unknown");
      await captureState(page, cell, "original-unknown-countries", h.button("original-countries"));
      await h.button("detail").getByRole("button").click();
      await page.getByTestId("mc-feedback").first().click();
      await h.button("feedback-action").selectOption("REJECT");
      await expect(h.button("feedback-dialog")).toBeVisible();
      await captureState(page, cell, "feedback-dialog-open-reject-after-correction");
      await h.button("feedback-save").click();
      await expect(h.button("feedback-dialog")).toHaveCount(0);
      await captureState(page, cell, "feedback-dialog-closed");
      await expect(page.getByTestId("mc-card").nth(1)).toContainText(
        cell.lang === "zh-CN" ? "待反馈" : "Pending feedback",
      );
      if ((await h.button("receipt").getAttribute("open")) === null)
        await h.button("receipt").locator("summary").click();
      await expect(h.button("receipt")).not.toContainText(
        cell.lang === "zh-CN"
          ? "用户纠正覆盖层，原提议未变"
          : "User correction overlay; original proposal unchanged",
      );
      await captureState(page, cell, "reject-receipt-after-correction", h.button("receipt"));
      h.check();
    });
    test("V16 review scope refusal preserves draft without false success", async ({ page }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      h.state.deny = "review";
      await page.getByTestId("mc-feedback").first().click();
      await h.button("reason").fill("Not granted");
      await h.button("feedback-save").click();
      await expect(h.button("feedback-error")).toBeVisible();
      const safe = safeErrorCopy("NOT_A_MEMBER", cell.lang);
      await expect(h.button("feedback-error-why")).toHaveText(safe.why);
      await expect(h.button("feedback-error-next")).toHaveText(safe.next);
      await expect(h.button("feedback-dialog")).not.toContainText(
        "SYNTHETIC_INTERNAL_DETAILS_NOT_FOR_UI",
      );
      await captureState(page, cell, "safe-feedback-error", h.button("feedback-error"));
      await captureState(page, cell, "feedback-error");
      await expect(h.button("feedback-save")).toBeDisabled();
      await expect(h.button("reason")).toHaveValue("Not granted");
      await expect(h.button("notice")).toHaveCount(0);
      h.check();
    });
    test("V14 version and idempotency conflicts have distinct explanations without automatic replays", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      await page.getByTestId("mc-feedback").first().click();
      await h.button("reason").fill("Preserve input");
      h.state.conflict = "VERSION_CONFLICT";
      await h.button("feedback-save").click();
      await expect(h.button("feedback-error")).toContainText(
        cell.lang === "zh-CN" ? "版本" : "version",
      );
      await captureState(page, cell, "feedback-error");
      expect(h.requests.filter((r) => r.path.endsWith("/feedback"))).toHaveLength(1);
      h.state.conflict = "";
      await h.button("feedback-check").click();
      await h.button("feedback-redecide").click();
      h.state.conflict = "IDEMPOTENCY_CONFLICT";
      await h.button("feedback-save").click();
      await expect(h.button("feedback-error")).toContainText(
        cell.lang === "zh-CN" ? "重复" : "identity",
      );
      await captureState(page, cell, "feedback-error");
      expect(h.requests.filter((r) => r.path.endsWith("/feedback"))).toHaveLength(2);
      h.check();
    });
    test("V14 known CAS conflict preserves own draft through checking and explicit new decision", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      await keyboardActivate(
        page,
        cell,
        "open-conflict-feedback",
        page.getByTestId("mc-feedback").first(),
      );
      await keyboardSelect(page, cell, "CORRECT");
      await keyboardType(
        page,
        cell,
        "conflict-correction",
        h.button("correction-application"),
        "My preserved correction",
      );
      await keyboardType(page, cell, "conflict-reason", h.button("reason"), "My preserved reason");
      h.advanceCurrent(2, "Concurrent source content");
      await keyboardActivate(page, cell, "save-conflict-feedback", h.button("feedback-save"));
      await expect(h.button("feedback-error")).toBeVisible();
      await captureState(page, cell, "feedback-error");
      await keyboardActivate(page, cell, "check-current", h.button("feedback-check"));
      await expect(h.button("feedback-current")).toContainText("Concurrent source content");
      await captureState(page, cell, "feedback-current");
      await expect(h.button("reason")).toHaveValue("My preserved reason");
      expect(h.state.feedbackWrites).toBe(0);
      await keyboardActivate(page, cell, "explicit-redecision", h.button("feedback-redecide"));
      await expect(h.button("correction-application")).toHaveValue("My preserved correction");
      await keyboardActivate(page, cell, "save-conflict-feedback", h.button("feedback-save"));
      await expect(h.button("feedback-dialog")).toHaveCount(0);
      await captureState(page, cell, "feedback-dialog-closed");
      const posts = h.requests.filter((r) => r.path.endsWith("/feedback"));
      expect(posts).toHaveLength(2);
      expect(posts[0]!.key).not.toBe(posts[1]!.key);
      expect(posts[0]!.body).toHaveProperty("expectedRevision", 1);
      expect(posts[1]!.body).toHaveProperty("expectedRevision", 2);
      expect(h.state.feedbackWrites).toBe(1);
      h.check();
    });
    test("V14 idempotency collision requires an explicit fresh decision, not a stale reaccept", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      await page.evaluate(() => {
        const keys = [
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        ];
        let n = 0;
        crypto.randomUUID = () =>
          keys[
            Math.min(n++, keys.length - 1)
          ] as `${string}-${string}-${string}-${string}-${string}`;
      });
      await page.getByTestId("mc-feedback").first().click();
      await h.button("reason").fill("Original accepted body");
      await h.button("feedback-save").click();
      await expect(h.button("feedback-dialog")).toHaveCount(0);
      await captureState(page, cell, "feedback-dialog-closed");
      await page.getByTestId("mc-feedback").first().click();
      await h.button("reason").fill("Different own body");
      await h.button("feedback-save").click();
      await expect(h.button("feedback-error")).toBeVisible();
      await captureState(page, cell, "feedback-error");
      expect(h.state.feedbackWrites).toBe(1);
      await h.button("feedback-check").click();
      await h.button("feedback-redecide").click();
      await h.button("feedback-save").click();
      await expect(h.button("feedback-dialog")).toHaveCount(0);
      await captureState(page, cell, "feedback-dialog-closed");
      expect(h.state.feedbackWrites).toBe(2);
      h.check();
    });
    test("V16 read refusal removes old receipt instead of retaining returned reason", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      await page.getByTestId("mc-feedback").first().click();
      await h.button("reason").fill("Submitted receipt text");
      await h.button("feedback-save").click();
      await expect(h.button("feedback-dialog")).toHaveCount(0);
      await captureState(page, cell, "feedback-dialog-closed");
      await expect(h.button("receipt")).toBeVisible();
      h.state.deny = "read";
      await h.button("refresh").click();
      await expect(h.button("error")).toBeVisible();
      await captureState(page, cell, "error");
      await expect(h.button("receipt")).toHaveCount(0);
      await expect(page.getByText("Submitted receipt text", { exact: true })).toHaveCount(0);
      h.check();
    });
    test("V16 slow read refusal removes correction base but preserves user-only draft without submission", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      const gate = deferred();
      h.state.latestWait = gate.promise;
      await h.button("refresh").click();
      await page.getByTestId("mc-feedback").first().click();
      await h.button("feedback-action").selectOption("CORRECT");
      await h.button("correction-application").fill("USER_ONLY_UNSUBMITTED");
      h.state.deny = "read";
      gate.resolve();
      await expect(h.button("error")).toBeVisible();
      await captureState(page, cell, "error");
      await expect(h.button("feedback-dialog")).toHaveCount(0);
      await captureState(page, cell, "feedback-dialog-closed");
      await expect(h.button("held-draft")).toContainText("USER_ONLY_UNSUBMITTED");
      await expect(page.getByText("Solar installations / 光伏项目", { exact: true })).toHaveCount(
        0,
      );
      await expect(page.getByTestId("mc-card")).toHaveCount(0);
      expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(0);
      h.check();
    });
    test("V12 successful feedback returns natural focus to its precise card trigger", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      const trigger = page.getByTestId("mc-feedback").nth(1);
      await trigger.focus();
      await page.keyboard.press("Enter");
      await h.button("feedback-save").click();
      await expect(h.button("feedback-dialog")).toHaveCount(0);
      await captureState(page, cell, "feedback-dialog-closed");
      await expect(trigger).toBeFocused();
      h.check();
    });
    test("V13 clearing corrected conditions removes the old overview condition but keeps original detail", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      await page.getByTestId("mc-feedback").first().click();
      await h.button("feedback-action").selectOption("CORRECT");
      await h.button("correction-entryConditions").fill("");
      await h.button("feedback-save").click();
      await expect(h.button("feedback-dialog")).toHaveCount(0);
      await captureState(page, cell, "feedback-dialog-closed");
      await expect(page.getByTestId("mc-card").first()).not.toContainText("Certification required");
      await page.getByTestId("mc-details").first().click();
      await expect(page.getByTestId("mc-detail")).toContainText("Certification required");
      await expect(page.getByTestId("mc-detail")).toContainText(
        cell.lang === "zh-CN" ? "用户已清空此项" : "Cleared by user correction",
      );
      h.check();
    });
  });

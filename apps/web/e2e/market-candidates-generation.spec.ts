import { expect, test } from "@playwright/test";
import {
  keyboardActivate,
  observeToasts,
  prepareCopy,
  safeErrorCopy,
  toastWasSeen,
  captureState,
  accessibleState,
  generation,
  ID,
  matrix,
  revision,
  setup,
} from "./support/market-candidates-fixtures";
for (const cell of matrix)
  test.describe(cell.label, () => {
    test.afterEach(async ({ page }, info) => {
      await accessibleState(page);
      const screenshot = info.outputPath("state.png");
      await page.screenshot({ path: screenshot, fullPage: true });
      await info.attach("original-size-state", { path: screenshot, contentType: "image/png" });
    });
    test("V06 prepare and execute are separate, running is not saved", async ({ page }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      await keyboardActivate(page, cell, "prepare", h.button("prepare"));
      await expect(h.button("phase")).toHaveAttribute("data-phase", "PREPARED");
      await captureState(page, cell, "phase");
      expect(h.requests.filter((r) => r.path.endsWith("/execute"))).toHaveLength(0);
      h.state.gen.phase = "RUNNING";
      await keyboardActivate(page, cell, "execute", h.button("execute"));
      await expect(h.button("phase")).toHaveAttribute("data-phase", "RUNNING");
      await captureState(page, cell, "phase");
      expect(h.requests.filter((r) => r.path.endsWith("/execute"))).toHaveLength(1);
      h.check();
    });
    test("V07 write scope rejection preserves readable candidates without execution", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      h.state.deny = "write";
      await h.button("prepare").click();
      await expect(h.button("error")).toBeVisible();
      await captureState(page, cell, "error");
      await expect(h.button("prepare")).toBeDisabled();
      await expect(page.getByTestId("mc-card")).toHaveCount(2);
      expect(h.requests.filter((r) => r.path.endsWith("/execute"))).toHaveLength(0);
      h.check();
    });
    test("V08 all non-success phases stay separate from a legal empty document", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      h.state.latest = { status: "NOT_ANALYZED", result: null };
      await h.open();
      await captureState(page, cell, "panel-open");
      await h.button("prepare").click();
      for (const phase of [
        "RUNNING",
        "RESULT_UNKNOWN",
        "RESULT_READY",
        "FAILED",
        "NOT_APPLIED",
      ] as const) {
        h.state.gen = generation(phase);
        await h.button("query").click();
        await expect(h.button("phase")).toHaveAttribute("data-phase", phase);
        const phaseText = {
          RUNNING: cell.lang === "zh-CN" ? "处理中" : "Processing",
          RESULT_UNKNOWN: cell.lang === "zh-CN" ? "结果待确认" : "Result pending",
          RESULT_READY:
            cell.lang === "zh-CN" ? "结果已取得，尚未保存" : "Result obtained, not yet saved",
          FAILED: cell.lang === "zh-CN" ? "执行失败" : "Failed",
          NOT_APPLIED: cell.lang === "zh-CN" ? "未应用" : "Not applied",
        }[phase];
        await expect(h.button("phase")).toContainText(phaseText);
        if (phase === "FAILED" || phase === "NOT_APPLIED") {
          await expect
            .soft(h.button("generation-reason"))
            .toContainText(cell.lang === "zh-CN" ? "原因未知" : "Reason unknown");
          await captureState(page, cell, "terminal-unknown-reason");
        }
        if (phase === "RESULT_READY") {
          await expect(h.button("not-analyzed").getByRole("heading")).toHaveText(
            cell.lang === "zh-CN"
              ? "尚无可读市场候选文档"
              : "No readable market candidate document yet",
          );
          await captureState(page, cell, "no-readable-document");
        }
        await captureState(page, cell, "phase");
        await expect(h.button("empty")).toHaveCount(0);
        await captureState(page, cell, "empty");
      }
      h.check();
    });
    test("V09 lost prepare keeps intent; lost execute never rebuys, survives reload", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      h.state.losePrepare = true;
      await h.button("prepare").click();
      await expect(h.button("error")).toBeVisible();
      await captureState(page, cell, "error");
      await h.button("prepare").click();
      await expect(h.button("phase")).toHaveAttribute("data-phase", "PREPARED");
      await captureState(page, cell, "phase");
      const prep = h.requests.filter(
        (r) => r.method === "POST" && r.path.endsWith("/market-candidate-generations"),
      );
      expect(prep).toHaveLength(2);
      expect(prep[0]!.body).toEqual(prep[1]!.body);
      h.state.loseExecute = true;
      await h.button("execute").click();
      await expect(h.button("phase")).toHaveAttribute("data-phase", "RESULT_UNKNOWN");
      await captureState(page, cell, "phase");
      h.state.gen = generation("RESULT_UNKNOWN");
      await page.reload();
      await h.open();
      await captureState(page, cell, "panel-open");
      await h.button("query").click();
      await expect(h.button("phase")).toHaveAttribute("data-phase", "RESULT_UNKNOWN");
      await captureState(page, cell, "phase");
      expect(h.requests.filter((r) => r.path.endsWith("/execute"))).toHaveLength(1);
      h.check();
    });
    test("V10 save-pending recovery verifies initial revision separately from newer latest", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      h.state.gen = generation("RESULT_READY");
      await h.open();
      await captureState(page, cell, "panel-open");
      await h.button("prepare").click();
      await expect(h.button("phase")).toHaveAttribute("data-phase", "RESULT_READY");
      await captureState(page, cell, "phase");
      h.state.gen = generation("PERSISTED");
      h.state.latest = { status: "AVAILABLE", result: revision(4) };
      await h.button("recover").click();
      await expect(h.button("phase")).toHaveAttribute("data-phase", "PERSISTED");
      await captureState(page, cell, "phase");
      await expect(h.button("revision-label")).toContainText("4");
      expect(
        h.requests.some(
          (r) => r.method === "GET" && r.path === `/market-candidate-sets/${ID.set}/revisions/1`,
        ),
      ).toBe(true);
      expect(h.requests.filter((r) => r.path.endsWith("/execute"))).toHaveLength(0);
      h.check();
    });
    test("V17 only explicit execute creates an execution request", async ({ page }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      await h.button("refresh").click();
      await page.getByTestId("mc-details").first().click();
      expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(0);
      await h.button("prepare").click();
      await h.button("query").click();
      await h.button("recover").click();
      expect(h.requests.filter((r) => r.path.endsWith("/execute"))).toHaveLength(0);
      h.check();
    });
    test("V18 buyer search stays an unavailable separate step", async ({ page }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      await expect(h.button("b4")).toBeVisible();
      await expect(h.button("b4").locator("button,a")).toHaveCount(0);
      expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(0);
      h.check();
    });
    test("V10 mismatching initial hash never presents saved success", async ({ page }) => {
      const h = await setup(page, cell);
      h.state.gen = generation("RESULT_READY");
      await h.open();
      await captureState(page, cell, "panel-open");
      await h.button("prepare").click();
      await expect(h.button("phase")).toHaveAttribute("data-phase", "RESULT_READY");
      await captureState(page, cell, "phase");
      h.state.badInitial = true;
      h.state.gen = generation("PERSISTED");
      await h.button("recover").click();
      await expect(h.button("error")).toBeVisible();
      await captureState(page, cell, "error");
      await expect(page.locator("[data-testid=mc-phase][data-phase=PERSISTED]")).toHaveCount(0);
      h.check();
    });
    test("V11 terminal generation allows a distinct explicit new intent", async ({ page }) => {
      const h = await setup(page, cell);
      h.state.gen = generation("PERSISTED");
      await h.open();
      await captureState(page, cell, "panel-open");
      await h.button("prepare").click();
      await expect(h.button("phase")).toHaveAttribute("data-phase", "PERSISTED");
      await captureState(page, cell, "phase");
      h.state.gen = generation("PREPARED");
      await h.button("new-intent").click();
      const confirmModal = page.locator(".ant-modal-confirm");
      await expect(confirmModal).toBeVisible();
      await confirmModal.locator(".ant-modal-confirm-btns button").last().click();
      await expect(h.button("phase")).toHaveAttribute("data-phase", "PREPARED");
      await captureState(page, cell, "phase");
      const posts = h.requests.filter(
        (r) => r.path.endsWith("/market-candidate-generations") && r.method === "POST",
      );
      expect(posts).toHaveLength(2);
      expect(posts[0]!.body).not.toEqual(posts[1]!.body);
      expect(h.requests.filter((r) => r.path.endsWith("/execute"))).toHaveLength(0);
      h.check();
    });

    test("V07 basis, authorization and budget refusals never execute implicitly", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      h.state.prepareError = "SCOPE_REQUIRED";
      await h.open();
      const checkCopy = async (code: string) => {
        const copy = prepareCopy(code, cell.lang);
        await expect(h.button("error")).toContainText(copy.title);
        await expect(h.button("error-why")).toHaveText(copy.why);
        await expect(h.button("error-next")).toHaveText(copy.next);
        await expect(page.getByTestId("mc-panel")).not.toContainText(
          "SYNTHETIC_INTERNAL_DETAILS_NOT_FOR_UI",
        );
        await captureState(page, cell, `safe-error-${code}`, h.button("error"));
        if (code === "NO_APPROVED_CLAIMS") {
          // Only initial prepare 400 + the two exact codes are page-owned inline notices.
          await expect(page.locator(".ant-message-notice")).toHaveCount(0, { timeout: 10000 });
        } else {
          // Other statuses keep the same-source global toast; do not suppress cold-read/execute/recover/feedback/5xx.
          await expect(
            page.locator(".ant-message-notice").filter({ hasText: copy.title }).first(),
          ).toBeVisible({ timeout: 10000 });
        }
        await captureState(page, cell, `safe-error-stable-${code}`, h.button("error"));
        console.log(
          JSON.stringify({
            kind: "PRIVATE_SAFE_USER_COPY",
            cell: cell.label,
            code,
            displayed: {
              title: copy.title,
              why: await h.button("error-why").textContent(),
              next: await h.button("error-next").textContent(),
            },
            synthetic_BFF_response_only: true,
          }),
        );
      };
      await h.button("prepare").click();
      await checkCopy("SCOPE_REQUIRED");
      await expect(page.getByTestId("mc-panel")).not.toContainText("你的操作会保留");
      await expect(page.getByTestId("mc-panel")).not.toContainText("稍后刷新重试即可");
      await expect(h.button("prepare")).toBeEnabled();
      await expect(page.getByTestId("mc-card")).toHaveCount(2);
      await h.button("close").click();
      h.state.prepareError = "";
      await h.open();
      h.state.prepareBasis = "NO_APPROVED_CLAIMS";
      await expect(page.locator(".ant-message-notice")).toHaveCount(0, { timeout: 10000 });
      await observeToasts(page);
      await h.button("prepare").click();
      await checkCopy("NO_APPROVED_CLAIMS");
      expect(await toastWasSeen(page)).toBe(false);
      h.state.prepareBasis = "VALID";
      h.state.prepareError = "SYNTHETIC_UNREGISTERED_ERROR";
      await h.button("prepare").click();
      await checkCopy("SYNTHETIC_UNREGISTERED_ERROR");
      const neutral =
        cell.lang === "zh-CN"
          ? {
              title: "暂时无法完成此操作",
              why: "当前信息不足以确认具体原因。",
              next: "有原操作时先查看其状态；仍无法继续时，请联系工作空间管理员或平台运营。",
            }
          : {
              title: "This action could not be completed",
              why: "There is not enough information to confirm the cause.",
              next: "Check the existing operation, if any. If you still cannot continue, contact your workspace admin or platform support.",
            };
      h.state.noCopy = true;
      await h.button("prepare").click();
      const noCopyNotice = page
        .locator(".ant-message-notice")
        .filter({ hasText: neutral.title })
        .first();
      await expect(noCopyNotice).toBeVisible({ timeout: 10000 });
      await expect(noCopyNotice).not.toContainText("SYNTHETIC_INTERNAL_DETAILS_NOT_FOR_UI");
      await expect(h.button("error")).toContainText(neutral.title);
      await expect(h.button("error-why")).toHaveText(neutral.why);
      await expect(h.button("error-next")).toHaveText(neutral.next);
      await expect(page.getByTestId("mc-panel")).not.toContainText(
        "SYNTHETIC_INTERNAL_DETAILS_NOT_FOR_UI",
      );
      h.state.noCopy = false;
      h.state.prepareError = "";
      await h.button("prepare").click();
      await expect(h.button("phase")).toHaveAttribute("data-phase", "PREPARED");
      h.state.executeError = "WORKSPACE_BUDGET_EXCEEDED";
      await h.button("execute").click();
      await checkCopy("WORKSPACE_BUDGET_EXCEEDED");
      await h.button("query").click();
      await expect(h.button("execute")).toBeEnabled();
      for (const code of [
        "EXECUTION_BUDGET_QUOTE_UNAVAILABLE",
        "EXECUTION_BUDGET_QUOTE_INVALID",
        "EXECUTION_BUDGET_GRANT_FAILED",
      ] as const) {
        h.state.executeError = code;
        await h.button("execute").click();
        await checkCopy(code);
        await expect(h.button("phase")).toHaveAttribute("data-phase", "PREPARED");
        await expect(h.button("execute")).toBeEnabled();
      }
      expect(h.state.executionDispatches).toBe(0);
      await expect(page.getByTestId("mc-card")).toHaveCount(2);
      h.check();
    });
    test("V08 refusal truncation and invalid output are failure not empty success", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      await h.button("prepare").click();
      for (const code of ["EXECUTION_REJECTED", "EXECUTION_FAILED", "OUTPUT_INVALID"] as const) {
        h.state.gen = generation("FAILED");
        h.state.gen.reasonCode = code;
        await h.button("query").click();
        await expect(h.button("phase")).toHaveAttribute("data-phase", "FAILED");
        await captureState(page, cell, "phase");
        await expect(page.getByTestId("mc-panel")).toContainText(
          cell.lang === "zh-CN" ? "费用未知" : "Cost unknown",
        );
        await expect(h.button("empty")).toHaveCount(0);
        await captureState(page, cell, "empty");
      }
      h.check();
    });
    test("V09 pending reference storage contains no candidate or feedback data", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      await h.button("prepare").click();
      await expect(h.button("phase")).toHaveAttribute("data-phase", "PREPARED");
      await captureState(page, cell, "phase");
      const stored = await page.evaluate(() =>
        sessionStorage.getItem("gainos-market-candidate-pending-v1"),
      );
      expect(stored).not.toBeNull();
      for (const item of JSON.parse(stored!)) {
        expect(Object.keys(item).sort()).toEqual([
          "attempted",
          "context",
          "generationId",
          "intentId",
        ]);
        expect(JSON.stringify(item)).not.toContain("Battery");
      }
      await expect(page.getByTestId("mc-panel")).toContainText(
        cell.lang === "zh-CN" ? "费用未知" : "Cost unknown",
      );
      h.check();
    });
    test("V09 refused storage is honestly volatile and does not auto-generate", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await page.evaluate(() => {
        const originalSet = Storage.prototype.setItem;
        const originalGet = Storage.prototype.getItem;
        Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
          if (key === "gainos-market-candidate-pending-v1")
            throw new Error("synthetic storage refusal");
          return originalSet.call(this, key, value);
        };
        Storage.prototype.getItem = function (this: Storage, key: string) {
          if (key === "gainos-market-candidate-pending-v1")
            throw new Error("synthetic storage refusal");
          return originalGet.call(this, key);
        };
      });
      await h.open();
      await captureState(page, cell, "panel-open");
      await expect(page.getByTestId("mc-panel")).toContainText(
        cell.lang === "zh-CN" ? "无法保存上下文" : "storage is unavailable",
      );
      expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(0);
      h.check();
    });
    test("V10 recovery failure and unknown keep original operation and unknown cost", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      h.state.gen = generation("RESULT_UNKNOWN");
      await h.open();
      await captureState(page, cell, "panel-open");
      await h.button("prepare").click();
      h.state.recoverError = "RESULT_NOT_FOUND";
      await h.button("recover").click();
      await expect(h.button("error")).toBeVisible();
      await captureState(page, cell, "error");
      h.state.recoverError = "";
      await h.button("recover").click();
      await expect(h.button("phase")).toHaveAttribute("data-phase", "RESULT_UNKNOWN");
      await captureState(page, cell, "phase");
      const recovery = h.requests.filter((r) => r.path.endsWith("/recover"));
      expect(recovery).toHaveLength(2);
      for (const item of recovery) {
        expect(item.path).toBe(`/market-candidate-generations/${ID.generation}/recover`);
        expect(item.body).toEqual({});
      }
      expect(h.requests.filter((r) => r.path.endsWith("/execute"))).toHaveLength(0);
      h.check();
    });

    test("V17 every other origin is blocked before any network delivery", async ({ page }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      for (const url of [
        "http://127.0.0.1:4532/blocked",
        "https://b3-network-denied.invalid/blocked",
      ]) {
        const failure = page.waitForEvent("requestfailed", (request) => request.url() === url);
        await page.evaluate((target) => fetch(target).catch(() => undefined), url);
        expect((await failure).failure()?.errorText).toContain("BLOCKED_BY_CLIENT");
      }
      expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(0);
      h.check();
    });
    test("V11 superseded and changed basis never imply a current new set or zero cost", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      await h.button("prepare").click();
      for (const reason of ["BASIS_CHANGED", "SUPERSEDED"] as const) {
        h.state.gen = generation("NOT_APPLIED");
        h.state.gen.reasonCode = reason;
        await h.button("query").click();
        await expect(h.button("phase")).toHaveAttribute("data-phase", "NOT_APPLIED");
        await captureState(page, cell, "phase");
        await expect(page.getByTestId("mc-panel")).toContainText(
          cell.lang === "zh-CN" ? "费用未知" : "Cost unknown",
        );
        await expect(page.getByTestId("mc-initial-reference")).toHaveCount(0);
      }
      h.check();
    });

    test("V07 known execute quota refusal can be checked then explicitly resumed on the same intent", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      await h.button("prepare").click();
      await expect(h.button("phase")).toHaveAttribute("data-phase", "PREPARED");
      await captureState(page, cell, "phase");
      h.state.executeError = "WORKSPACE_BUDGET_EXCEEDED";
      await h.button("execute").click();
      await expect(h.button("error")).toBeVisible();
      await captureState(page, cell, "error");
      expect(h.state.executionDispatches).toBe(0);
      await page.reload();
      await h.open();
      await captureState(page, cell, "panel-open");
      await h.button("query").click();
      await expect(h.button("phase")).toHaveAttribute("data-phase", "PREPARED");
      await captureState(page, cell, "phase");
      await expect(h.button("execute")).toBeEnabled();
      h.state.executeError = "";
      h.state.gen = generation("RUNNING");
      await h.button("execute").click();
      await expect(h.button("phase")).toHaveAttribute("data-phase", "RUNNING");
      await captureState(page, cell, "phase");
      expect(
        h.requests.filter(
          (r) => r.method === "POST" && r.path.endsWith("/market-candidate-generations"),
        ),
      ).toHaveLength(1);
      expect(h.state.executionDispatches).toBe(1);
      h.check();
    });
    test("V09 a network-unknown execute is not reenabled by an ambiguous prepared query", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      await h.open();
      await captureState(page, cell, "panel-open");
      await h.button("prepare").click();
      await expect(h.button("phase")).toHaveAttribute("data-phase", "PREPARED");
      await captureState(page, cell, "phase");
      h.state.loseExecute = true;
      await h.button("execute").click();
      await expect(h.button("phase")).toHaveAttribute("data-phase", "RESULT_UNKNOWN");
      await captureState(page, cell, "phase");
      await h.button("query").click();
      await expect(h.button("phase")).toHaveAttribute("data-phase", "PREPARED");
      await captureState(page, cell, "phase");
      await expect(h.button("execute")).toBeDisabled();
      expect(h.state.executionDispatches).toBe(1);
      h.check();
    });

    test("V10 persisted initial reference is a real revision-one element, absent for unapplied result", async ({
      page,
    }) => {
      const h = await setup(page, cell);
      h.state.gen = generation("PERSISTED");
      await h.open();
      await captureState(page, cell, "panel-open");
      await h.button("prepare").click();
      await expect(h.button("phase")).toHaveAttribute("data-phase", "PERSISTED");
      await captureState(page, cell, "phase");
      await expect(h.button("initial-reference")).toBeVisible();
      await expect(h.button("initial-reference")).toContainText("1");
      h.state.gen = generation("NOT_APPLIED");
      await h.button("query").click();
      await expect(h.button("phase")).toHaveAttribute("data-phase", "NOT_APPLIED");
      await captureState(page, cell, "phase");
      await expect(h.button("initial-reference")).toHaveCount(0);
      h.check();
    });
  });

// M7b-1 ticket #4: the notebook pane's liveness. The pane renders the
// fixture project's notebook whole; a line appended by an outside writer
// (plain fs, the way any TUI session appends) appears in every open pane
// without a reload; a malformed appended line never renders; a re-sent
// line renders once (line bytes are the identity); a second tab on the
// same project is tolerated and stays live.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "path";
import { showSidebarSessions } from "./sidebar.mjs";

export const NOTEBOOK_SESSION_ID = "e2e-notebook-pane";

const entries = [
  { id: "hyp-1", type: "hypothesis", date: "2026-11-20", text: "E2E compound lowers IC50", evidence: [{ source: "pubmed", endpoints: ["esearch", "esummary"], retrieved: "2026-11-20", grade: "asserted", snapshot: "sha256:e2e" }] },
  { id: "mth-1", type: "method", date: "2026-11-20", text: "E2E docking screen" },
  { id: "obs-1", type: "observation", date: "2026-11-20", text: "E2E top hit binds", grade: "cross-checked", evidence: [{ source: "pubmed", retrieved: "2026-11-20", grade: "cross-checked", supports: "hyp-1" }] },
  { id: "dec-1", type: "decision", date: "2026-11-20", text: "E2E advance hit 3" },
  { id: "cnf-1", type: "confidence", date: "2026-11-20", hypothesis: "hyp-1", text: "E2E downgraded to probable", evidence: [{ source: "pubmed", retrieved: "2026-11-20", grade: "asserted" }] },
];
const appendedObservation = (id, text) => JSON.stringify({
  id,
  type: "observation",
  date: "2026-11-20",
  text,
  grade: "asserted",
  evidence: [{ source: "pubmed", retrieved: "2026-11-20", grade: "asserted" }],
});

/** Seed before server start: a project whose notebook exists, with a session in it. */
export function createNotebookPaneFixtures({ agentDir, sessionDir, timestamp }) {
  const project = join(realpathSync(agentDir), "notebook-project");
  const notebookDir = join(project, ".theta");
  mkdirSync(notebookDir, { recursive: true });
  const notebook = join(notebookDir, "notebook.jsonl");
  writeFileSync(notebook, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const sessionEntries = [
    { type: "session", version: 3, id: NOTEBOOK_SESSION_ID, timestamp, cwd: project },
    { type: "message", id: "notebook-user", parentId: null, timestamp, message: { role: "user", content: "E2E notebook pane" } },
    { type: "message", id: "notebook-answer", parentId: "notebook-user", timestamp, message: { role: "assistant", content: "E2E notebook answer" } },
  ];
  writeFileSync(join(sessionDir, `2026-08-23T00-00-00-000Z_${NOTEBOOK_SESSION_ID}.jsonl`),
    sessionEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { project, notebook };
}

async function openNotebookPane(page, { base, groupKey }) {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await showSidebarSessions(page);
  const row = page.locator(`[data-row-key=${JSON.stringify(`group:${groupKey}`)}]`);
  await row.hover();
  await row.locator("button[aria-haspopup='menu']").click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Show notebook" }).click();
  const pane = page.locator(".notebook-panel");
  await pane.waitFor({ state: "visible" });
  return pane;
}

export async function checkNotebookPane({ browser, base, artifacts, fixture, api }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const errors = [];
  try {
    const sessions = (await api("/api/sessions")).sessions;
    const mine = sessions.find((session) => session.id === NOTEBOOK_SESSION_ID);
    assert.ok(mine?.projectKey, "the notebook fixture project has its server identity");
    const groupKey = mine.projectKey;

    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.url().startsWith(base) && response.status() >= 500) errors.push(`${response.status()} ${response.url()}`);
    });

    // Full render of the existing notebook.
    const pane = await openNotebookPane(page, { base, groupKey });
    await pane.locator(".notebook-heading").getByText("Theta notebook - 5 entries - grades: 2 asserted, 2 cross-checked", { exact: true }).waitFor();
    let rowOrder = [];
    for (const id of ["hyp-1", "mth-1", "obs-1", "dec-1", "cnf-1"]) {
      await pane.getByText(id, { exact: true }).waitFor();
      rowOrder.push(await pane.getByText(id, { exact: true }).evaluate((element) => {
        const row = element.closest(".notebook-entry");
        return [...row.parentElement.children].indexOf(row);
      }));
    }
    assert.deepEqual(rowOrder, [0, 1, 2, 3, 4], "entries render in file order");
    await pane.locator(".notebook-grade[data-grade='cross-checked']").first().waitFor();

    // A reload marker: if the page reloaded to show the new line, it dies.
    await page.evaluate(() => { window.e2eNoReload = true; });

    // A well-formed append by an outside writer appears live.
    const live = appendedObservation("obs-2", "E2E second replicate binds");
    appendFileSync(fixture.notebook, `${live}\n`);
    await pane.getByText("E2E second replicate binds").waitFor();
    await pane.locator(".notebook-heading").getByText("Theta notebook - 6 entries", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.e2eNoReload), true, "the live append must not reload the pane");

    // A re-sent line renders once — line bytes are the identity.
    appendFileSync(fixture.notebook, `${live}\n`);
    await page.waitForTimeout(1_000);
    assert.equal(await pane.getByText("E2E second replicate binds").count(), 1, "a re-sent line must not render twice");
    await pane.locator(".notebook-heading").getByText("Theta notebook - 6 entries", { exact: true }).waitFor();

    // A malformed append never renders, and the trail around it stands.
    appendFileSync(fixture.notebook, "not json at all\n");
    await page.waitForTimeout(1_000);
    assert.equal(await pane.getByText("not json at all").count(), 0, "a malformed appended line must never render");
    await pane.getByText("E2E second replicate binds").waitFor();
    await pane.locator(".notebook-heading").getByText("Theta notebook - 6 entries", { exact: true }).waitFor();
    await page.screenshot({ path: join(artifacts, "notebook-pane-live.png") });

    // A second tab on the same project: tolerated, and every open pane
    // stays live — the next append lands in both.
    const second = await context.newPage();
    second.setDefaultTimeout(30_000);
    second.on("pageerror", (error) => errors.push(error.message));
    const paneTwo = await openNotebookPane(second, { base, groupKey });
    await paneTwo.getByText("E2E second replicate binds").waitFor({ state: "visible" });
    await second.evaluate(() => { window.e2eNoReload = true; });
    const third = appendedObservation("obs-3", "E2E third replicate binds");
    appendFileSync(fixture.notebook, `${third}\n`);
    await pane.getByText("E2E third replicate binds").waitFor();
    await paneTwo.getByText("E2E third replicate binds").waitFor();
    assert.equal(await page.evaluate(() => window.e2eNoReload), true);
    assert.equal(await second.evaluate(() => window.e2eNoReload), true, "neither pane may reload");

    assert.deepEqual(errors, [], "browser errors in the notebook pane check");
    console.log("PASS: notebook pane renders whole, appends live without reload, skips malformed lines, dedupes re-sent lines, and holds two live tabs");
    await context.tracing.stop();
  } catch (error) {
    const page = context.pages()[0];
    if (page) await page.screenshot({ path: join(artifacts, "notebook-pane-failure.png") }).catch(() => {});
    await context.tracing.stop({ path: join(artifacts, "notebook-pane-trace.zip") }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

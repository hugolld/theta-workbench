import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { NotebookPanelView } = await jiti.import("./NotebookPanel.tsx");
const { notebookViewModel } = await jiti.import("../lib/notebook.ts");

const h = React.createElement;

// The fixture project's notebook — the same five-type shape the lib seam pins.
const notebook = notebookViewModel([
  JSON.stringify({ id: "hyp-1", type: "hypothesis", date: "2026-11-18", text: "Compound X lowers IC50 below 10 nM", evidence: [{ source: "pubmed", endpoints: ["esearch", "esummary"], retrieved: "2026-11-18", grade: "asserted", snapshot: "sha256:abc" }] }),
  JSON.stringify({ id: "mth-1", type: "method", date: "2026-11-18", text: "Docking screen over the kinase panel" }),
  JSON.stringify({ id: "obs-1", type: "observation", date: "2026-11-19", text: "Top hit binds the ATP pocket", grade: "cross-checked", evidence: [{ source: "pubmed", endpoints: ["efetch"], retrieved: "2026-11-19", grade: "cross-checked", supports: "hyp-1" }] }),
  JSON.stringify({ id: "dec-1", type: "decision", date: "2026-11-19", text: "Advance hit 3 to the follow-up screen" }),
  JSON.stringify({ id: "cnf-1", type: "confidence", date: "2026-11-19", hypothesis: "hyp-1", text: "Downgraded: only 2 of 5 replicates reproduced", evidence: [{ source: "pubmed", retrieved: "2026-11-19", grade: "asserted" }] }),
].join("\n") + "\n");

const t = (key, params) => {
  const messages = {
    "notebook.panelLabel": "Project notebook",
    "notebook.absent": "No project notebook in this directory",
    "notebook.loadFailed": "Could not read the project notebook",
    "notebook.refresh": "Refresh",
    "notebook.supports": "supports",
    "notebook.snapshot": "snapshot",
  };
  let text = messages[key] ?? key;
  if (params) for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
};

const render = (props) => renderToStaticMarkup(h(NotebookPanelView, {
  notebook, failed: false, loading: false, expanded: new Set(),
  onToggleEvidence() {}, onRefresh() {}, t, ...props,
}));

test("the pane renders the grammar: header, file-order rows, grade badges", () => {
  const html = render();
  assert.match(html, /Theta notebook - 5 entries - grades: 2 asserted, 2 cross-checked/);
  const rowOrder = ["hyp-1", "mth-1", "obs-1", "dec-1", "cnf-1"].map((id) => html.indexOf(id));
  assert.ok(rowOrder.every((at, index) => at !== -1 && (index === 0 || at > rowOrder[index - 1])), `rows out of order: ${rowOrder.join(", ")}`);
  // The observation's own grade is a badge; a confidence carries no grade — judgment's lead is plain text.
  assert.match(html, /data-grade="cross-checked"/);
  assert.ok(html.includes("judgment on hyp-1 - Downgraded: only 2 of 5 replicates reproduced"));
});

test("evidence items are grade-badged lines with expandable detail", () => {
  const collapsed = render();
  // The badge and the supports link are visible collapsed…
  assert.match(collapsed, /pubmed[^<]*<\/span>/);
  assert.ok(collapsed.includes("[cross-checked]"));
  assert.ok(collapsed.includes("supports hyp-1"));
  // …the retrieval detail stays behind the expand.
  assert.ok(!collapsed.includes("retrieved 2026-11-18 via esearch, esummary"));
  assert.ok(!collapsed.includes("sha256:abc"));

  const expanded = render({ expanded: new Set(["hyp-1:0"]) });
  assert.ok(expanded.includes("retrieved 2026-11-18 via esearch, esummary"));
  assert.ok(expanded.includes("snapshot sha256:abc"));
  assert.match(expanded, /aria-expanded="true"/);
});

test("a project without a notebook renders the absence wording, never an error", () => {
  const html = render({ notebook: null });
  assert.ok(html.includes("No project notebook in this directory"));
  assert.ok(!html.includes("hyp-1"));
});

test("a failed read says so and does not render a stale trail", () => {
  const html = render({ notebook: null, failed: true });
  assert.ok(html.includes("Could not read the project notebook"));
  assert.ok(!html.includes("hyp-1"));
});

test("the pane offers no notebook mutation path — refresh is the only action", () => {
  const html = render();
  const buttons = [...html.matchAll(/<button[^>]*>/g)].map(([tag]) => tag);
  assert.equal(buttons.length, 1 + notebook.entries.reduce((count, entry) => count + entry.evidence.length, 0));
  assert.match(buttons[0], /Refresh|refresh/);
  // The evidence toggles carry no submit semantics.
  assert.ok(buttons.slice(1).every((tag) => tag.includes('type="button"')));
});

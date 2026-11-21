import assert from "node:assert/strict";
import test from "node:test";
import { notebookViewModel } from "./notebook.ts";

// A research notebook in the recorder's shape (ADR 0003's five entry types).
const lines = [
  {
    id: "hyp-1",
    type: "hypothesis",
    date: "2026-11-18",
    text: "Compound X lowers IC50 below 10 nM",
    evidence: [{ source: "pubmed", endpoints: ["esearch", "esummary"], retrieved: "2026-11-18", grade: "asserted", snapshot: "sha256:abc" }],
  },
  { id: "mth-1", type: "method", date: "2026-11-18", text: "Docking screen over the kinase panel" },
  {
    id: "obs-1",
    type: "observation",
    date: "2026-11-19",
    text: "Top hit binds the ATP pocket",
    grade: "cross-checked",
    evidence: [{ source: "pubmed", endpoints: ["efetch"], retrieved: "2026-11-19", grade: "cross-checked" }],
  },
  { id: "dec-1", type: "decision", date: "2026-11-19", text: "Advance hit 3 to the follow-up screen" },
  {
    id: "cnf-1",
    type: "confidence",
    date: "2026-11-19",
    hypothesis: "hyp-1",
    text: "Downgraded: only 2 of 5 replicates reproduced",
    evidence: [{ source: "pubmed", retrieved: "2026-11-19", grade: "asserted" }],
  },
];

const notebookOf = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

test("a malformed line never renders — one corrupt line cannot break the pane", () => {
  const good = JSON.stringify(lines[1]);
  const malformed = [
    "not json at all",
    JSON.stringify(null),
    JSON.stringify(["obs-1"]),
    JSON.stringify({ id: "dec-9", type: "method", date: "2026-11-18", text: "id prefix does not match its type" }),
    JSON.stringify({ id: "mth_x", type: "method", date: "2026-11-18", text: "id not shaped" }),
    JSON.stringify({ id: "mth-3", type: "method", date: "2026-02-30", text: "date is not a real calendar day" }),
    JSON.stringify({ id: "mth-4", type: "method", date: "2026-1-1", text: "date shape wrong" }),
    JSON.stringify({ id: "mth-5", type: "method", date: "2026-11-18", text: "" }),
    JSON.stringify({ id: "obs-2", type: "observation", date: "2026-11-18", text: "no grade", evidence: [{ source: "pubmed", retrieved: "2026-11-18", grade: "asserted" }] }),
    JSON.stringify({ id: "obs-3", type: "observation", date: "2026-11-18", text: "grade outside vocabulary", grade: "verified", evidence: [{ source: "pubmed", retrieved: "2026-11-18", grade: "asserted" }] }),
    JSON.stringify({ id: "hyp-2", type: "hypothesis", date: "2026-11-18", text: "no evidence" }),
    JSON.stringify({ id: "hyp-3", type: "hypothesis", date: "2026-11-18", text: "empty evidence", evidence: [] }),
    JSON.stringify({ id: "cnf-2", type: "confidence", date: "2026-11-18", text: "no hypothesis", evidence: [{ source: "pubmed", retrieved: "2026-11-18", grade: "asserted" }] }),
    JSON.stringify({ id: "cnf-3", type: "confidence", date: "2026-11-18", hypothesis: "obs-1", text: "hypothesis ref not a hypothesis id" }),
    JSON.stringify({ id: "mth-6", type: "method", date: "2026-11-18", text: "evidence item without source", evidence: [{ retrieved: "2026-11-18", grade: "asserted" }] }),
    JSON.stringify({ id: "mth-7", type: "method", date: "2026-11-18", text: "evidence item grade outside vocabulary", evidence: [{ source: "pubmed", retrieved: "2026-11-18", grade: "confirmed" }] }),
    JSON.stringify({ id: "mth-8", type: "method", date: "2026-11-18", text: "evidence item retrieved not a date", evidence: [{ source: "pubmed", retrieved: "yesterday", grade: "asserted" }] }),
    JSON.stringify({ id: "mth-9", type: "method", date: "2026-11-18", text: "evidence item supports not a hypothesis ref", evidence: [{ source: "pubmed", retrieved: "2026-11-18", grade: "asserted", supports: "dec-1" }] }),
  ];
  const view = notebookViewModel([good, ...malformed].join("\n") + "\n");
  assert.deepEqual(view.entries.map((entry) => entry.id), ["mth-1"]);
  // Totals count exactly what renders: the corrupt entries' grades never join.
  assert.deepEqual(view.header.gradeTotals, []);
  assert.equal(view.header.text, "Theta notebook - 1 entry");
});

test("identical line bytes dedupe — line bytes are the entry identity", () => {
  const one = JSON.stringify(lines[1]);
  const view = notebookViewModel([one, one, JSON.stringify(lines[2]), one].join("\n") + "\n");
  assert.deepEqual(view.entries.map((entry) => entry.id), ["mth-1", "obs-1"]);
  assert.equal(view.header.entryCount, 2);
});

test("a torn write's tail stays invisible until its newline lands", () => {
  const complete = `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const torn = `${complete}${JSON.stringify({ id: "obs-9", type: "observation", date: "2026-11-19", text: "mid-write", grade: "asserted", evidence: [{ source: "pubmed", retrieved: "2026-11-19", grade: "asserted" }] })}`;
  const view = notebookViewModel(torn);
  assert.ok(!view.entries.some((entry) => entry.id === "obs-9"));
  assert.equal(view.header.entryCount, 5);
});

test("a gateway job record's evidence detail names the job, its state and template", () => {
  const view = notebookViewModel(`${JSON.stringify({
    id: "mth-2",
    type: "method",
    date: "2026-11-19",
    text: "Structure prediction submitted to the cluster",
    evidence: [{ source: "theta-compute", job_id: "900001", state: "COMPLETED", template: "alphafold3", retrieved: "2026-11-19", grade: "re-executed", snapshot: "sha256:def", supports: "hyp-1" }],
  })}\n`);
  const item = view.entries[0].evidence[0];
  assert.equal(item.detail, "job 900001 COMPLETED · template alphafold3 · retrieved 2026-11-19");
  assert.equal(item.grade, "re-executed");
  assert.equal(item.supports, "hyp-1");
  assert.equal(item.snapshot, "sha256:def");
});

test("an empty notebook carries the zero header with no grades clause", () => {
  const view = notebookViewModel("");
  assert.equal(view.header.text, "Theta notebook - 0 entries");
  assert.deepEqual(view.entries, []);
  assert.deepEqual(view.header.gradeTotals, []);
});

test("a valid notebook renders the grammar: header counts and grade totals, file-order rows", () => {
  const view = notebookViewModel(notebookOf(lines));
  assert.equal(view.header.entryCount, 5);
  assert.deepEqual(view.header.gradeTotals, [
    { grade: "asserted", count: 2 },
    { grade: "cross-checked", count: 2 },
  ]);
  assert.equal(view.header.text, "Theta notebook - 5 entries - grades: 2 asserted, 2 cross-checked");
  assert.deepEqual(view.entries.map((entry) => entry.id), ["hyp-1", "mth-1", "obs-1", "dec-1", "cnf-1"]);
});

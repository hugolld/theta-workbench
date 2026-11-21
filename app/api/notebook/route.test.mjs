import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

// Hermetic pi state: no sessions on disk, so the only allowed roots are the
// ones this test adds.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-notebook-route-")));
fs.writeFileSync(path.join(root, "gitconfig"), "");
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("../../../lib/allowed-roots.ts");

const project = path.join(root, "pep5");
function writeNotebook(lines) {
  fs.mkdirSync(path.join(project, ".theta"), { recursive: true });
  fs.writeFileSync(path.join(project, ".theta", "notebook.jsonl"), `${lines.join("\n")}\n`);
}

function request(cwd) {
  return GET(new NextRequest(`http://localhost/api/notebook?cwd=${encodeURIComponent(cwd)}`));
}

test("reads the project's notebook once and serves the view-model", async () => {
  const raw = [
    JSON.stringify({ id: "hyp-1", type: "hypothesis", date: "2026-11-18", text: "Compound X lowers IC50", evidence: [{ source: "pubmed", retrieved: "2026-11-18", grade: "asserted" }] }),
    "not json at all",
    JSON.stringify({ id: "obs-1", type: "observation", date: "2026-11-19", text: "Top hit binds", grade: "cross-checked", evidence: [{ source: "pubmed", retrieved: "2026-11-19", grade: "cross-checked" }] }),
  ];
  writeNotebook(raw);
  allowFileRoot(project);
  const response = await request(project);
  assert.equal(response.status, 200);
  const { notebook, lines } = await response.json();
  // The malformed line never renders; the grammar renders what is left.
  assert.equal(notebook.header.entryCount, 2);
  assert.equal(notebook.header.text, "Theta notebook - 2 entries - grades: 1 asserted, 2 cross-checked");
  assert.deepEqual(notebook.entries.map((entry) => entry.id), ["hyp-1", "obs-1"]);
  assert.equal(notebook.entries[1].rowText, "[cross-checked] Top hit binds");
  // The pane's live buffer starts from the same bytes (ticket #4): the
  // complete lines raw, malformed included — the render gate judges them.
  assert.deepEqual(lines, raw);
});

test("a torn write rides no line in the GET handover", async () => {
  const complete = JSON.stringify({ id: "mth-1", type: "method", date: "2026-11-18", text: "Torn tail check" });
  fs.mkdirSync(path.join(project, ".theta"), { recursive: true });
  // The trailing segment carries no newline — a write still in flight.
  fs.writeFileSync(path.join(project, ".theta", "notebook.jsonl"), `${complete}\n{"id":"obs-9","type":"observ`);
  const response = await request(project);
  assert.equal(response.status, 200);
  const { lines } = await response.json();
  assert.deepEqual(lines, [complete]);
});

test("a project without a notebook is an absence, never an error", async () => {
  const bare = path.join(root, "bare-project");
  fs.mkdirSync(bare, { recursive: true });
  allowFileRoot(bare);
  const response = await request(bare);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { notebook: null });
});

test("a symlinked notebook inside an allowed root cannot name a file outside it", async () => {
  const linked = path.join(root, "linked-project");
  fs.mkdirSync(path.join(linked, ".theta"), { recursive: true });
  const outside = path.join(root, "outside", "secret-notebook.jsonl");
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, JSON.stringify({ id: "mth-1", type: "method", date: "2026-11-18", text: "smuggled" }));
  fs.symlinkSync(outside, path.join(linked, ".theta", "notebook.jsonl"));
  allowFileRoot(linked);
  const response = await request(linked);
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error, "Access denied");
});

test("a cwd outside the allowed roots is refused", async () => {
  const response = await request(path.join(root, "never-allowed"));
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error, "Access denied");
});

test("a missing cwd parameter is a bad request", async () => {
  const response = await GET(new NextRequest("http://localhost/api/notebook"));
  assert.equal(response.status, 400);
});

test("no notebook mutation path exists from the browser — the route is GET-only", async () => {
  const route = await jiti.import("./route.ts");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(route[method], undefined, `${method} must not exist on the notebook route`);
  }
});

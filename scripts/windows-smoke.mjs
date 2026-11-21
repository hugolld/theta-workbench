// Ticket #6 (M7b-1): the Windows Node smoke's boot check. Runs wherever
// Node runs — the windows-smoke workflow on GitHub's windows-latest runner
// (the plain-Node, no-WSL Windows host of record) and any local checkout
// for proof. It builds nothing: `npm run build` is the caller's step. It
// starts the production server (`next start`, ephemeral loopback port, the
// e2e runner's isolation — a throwaway PI_CODING_AGENT_DIR so the smoke
// never touches a real session store), seeds one fixture session whose
// project carries the fixture notebook (the same fixture the notebook-pane
// e2e renders), then asserts the backend answers, the session is served,
// the app page serves, and the notebook view-model carries the pane's
// grammar header. The machine-readable verdict lands in result.json beside
// the server log, because stdout here is the human log.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createNotebookPaneFixtures, NOTEBOOK_SESSION_ID } from "../e2e/notebook-pane.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts = join(root, "test-results", "windows-smoke");
mkdirSync(artifacts, { recursive: true });
assert.ok(existsSync(join(root, ".next", "BUILD_ID")), "No production build — run npm run build first");
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-smoke-"));
const sessionDir = join(agentDir, "sessions", "e2e");
mkdirSync(sessionDir, { recursive: true });
const notebookPane = createNotebookPaneFixtures({ agentDir, sessionDir, timestamp: "2026-08-23T00:00:00.000Z" });

// The expected grammar header for the fixture notebook (5 entries; the
// observation's own cross-checked grade plus its evidence item's, and the
// hypothesis and confidence evidence items asserted).
const NOTEBOOK_HEADER = "Theta notebook - 5 entries - grades: 2 asserted, 2 cross-checked";

let server;
let serverExited;
let serverError;
const serverLog = createWriteStream(join(artifacts, "server.log"));
const interrupt = () => {
  process.exitCode = 1;
  server?.kill("SIGTERM");
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

const startedAt = Date.now();
let served = false;
try {
  // An ephemeral port, claimed then released, so the smoke never contends
  // with a developer's own 30141 server.
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  // Resolve `next` from this script's own location (bin/prepare-terminal.js's
  // pattern): CI installs node_modules inside the checkout, while a nested
  // worktree rides the parent checkout's — an entry path built by join only
  // works in the first.
  const nextBin = join(dirname(createRequire(import.meta.url).resolve("next/package.json")), "dist", "bin", "next");
  server = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.once("error", (error) => { serverError = error; });
  serverExited = once(server, "exit");
  server.stdout.pipe(serverLog, { end: false });
  server.stderr.pipe(serverLog, { end: false });

  const deadline = Date.now() + 120_000;
  while (true) {
    if (serverError) throw serverError;
    assert.equal(server.exitCode, null, "Server exited before readiness; see test-results/windows-smoke/server.log");
    const response = await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (response?.ok) break;
    assert.ok(Date.now() < deadline, "Server readiness timed out; see test-results/windows-smoke/server.log");
    await delay(250);
  }

  const sessions = await (await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(30_000) })).json();
  assert.ok(
    sessions.sessions.some((session) => session.id === NOTEBOOK_SESSION_ID),
    "The seeded notebook session must be served",
  );
  const page = await fetch(base, { signal: AbortSignal.timeout(30_000) });
  assert.equal(page.status, 200, "GET / must serve the app");
  assert.ok((page.headers.get("content-type") ?? "").startsWith("text/html"), "GET / must serve HTML");
  const notebook = await (await fetch(`${base}/api/notebook?cwd=${encodeURIComponent(notebookPane.project)}`, { signal: AbortSignal.timeout(30_000) })).json();
  assert.equal(notebook.notebook?.header?.text, NOTEBOOK_HEADER, "The notebook view-model must carry the pane's grammar header");
  assert.equal(notebook.notebook?.header?.entryCount, 5);
  served = true;
  console.log(`PASS: production server boots on ${process.platform} (Node ${process.version}) and serves the seeded session, the app page, and the notebook view-model`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    const forceKill = setTimeout(() => server.kill("SIGKILL"), 10_000);
    await serverExited;
    clearTimeout(forceKill);
  }
  serverLog.end();
  rmSync(agentDir, { recursive: true, force: true });
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  try {
    const result = {
      ok: served && process.exitCode !== 1,
      platform: process.platform,
      node: process.version,
      servedSession: NOTEBOOK_SESSION_ID,
      notebookHeader: NOTEBOOK_HEADER,
      elapsedMs: Date.now() - startedAt,
    };
    if (process.exitCode === 1) result.error = "boot or serve failed; see server.log beside this file";
    // Payload output and this file share the stdout channel, so the
    // machine-readable verdict lands here; its write must never mask the
    // primary failure.
    writeFileSync(join(artifacts, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  } catch {
    // The verdict file is diagnostics; its failure never masks the primary one.
  }
}

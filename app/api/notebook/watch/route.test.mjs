import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

// Hermetic pi state: no sessions on disk, so the only allowed roots are the
// ones this test adds (the same shape the notebook GET route's test pins).
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-notebook-watch-")));
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
const { allowFileRoot } = await jiti.import("../../../../lib/allowed-roots.ts");

const project = path.join(root, "pep5");
fs.mkdirSync(project, { recursive: true });
allowFileRoot(project);

const notebookPath = path.join(project, ".theta", "notebook.jsonl");
const observation = (id, text) => JSON.stringify({
  id,
  type: "observation",
  date: "2026-11-20",
  text,
  grade: "asserted",
  evidence: [{ source: "pubmed", retrieved: "2026-11-20", grade: "asserted" }],
});

function request(cwd) {
  return GET(new NextRequest(`http://localhost/api/notebook/watch?cwd=${encodeURIComponent(cwd)}`));
}

/**
 * Reads the route's SSE body into ordered frames; `waitFor` asserts the next
 * frame's event name (the stream is deterministic under a single writer), so
 * a surprise event fails the pin instead of hiding behind a filter.
 */
async function sse(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = "";
  let closed = false;
  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at;
        while ((at = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1] ?? "message";
          const dataRaw = /^data: (.*)$/m.exec(frame)?.[1];
          frames.push({ event, data: dataRaw === undefined ? null : JSON.parse(dataRaw) });
        }
      }
    } catch {
      // the stream ended under us (route closed it) — frames so far stand
    } finally {
      closed = true;
    }
  })();
  let cursor = 0;
  return {
    async waitFor(eventName, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (frames.length > cursor) {
          const frame = frames[cursor++];
          assert.equal(frame.event, eventName, `expected ${eventName}, got ${frame.event}: ${JSON.stringify(frame.data)}`);
          return frame;
        }
        assert.equal(closed, false, `stream closed while waiting for ${eventName}`);
        await delay(25);
      }
      assert.fail(`no ${eventName} within ${timeoutMs}ms; frames so far: ${JSON.stringify(frames.slice(cursor))}`);
    },
    async expectSilence(windowMs = 500) {
      const before = frames.length;
      await delay(windowMs);
      assert.deepEqual(frames.slice(before), [], "no frames expected in this window");
    },
    async waitClosed(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (closed) return;
        await delay(25);
      }
      assert.fail(`stream stayed open for ${timeoutMs}ms`);
    },
    stop: () => { void reader.cancel().catch(() => {}); return pump; },
  };
}

test("a cwd outside the allowed roots is refused, a missing cwd is a bad request", async () => {
  const outside = await request(path.join(root, "never-allowed"));
  assert.equal(outside.status, 403);
  assert.equal((await outside.json()).error, "Access denied");
  assert.equal((await GET(new NextRequest("http://localhost/api/notebook/watch"))).status, 400);
});

test("no notebook mutation path exists from the browser — the watch route is GET-only", async () => {
  const route = await jiti.import("./route.ts");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(route[method], undefined, `${method} must not exist on the notebook watch route`);
  }
});

test("a symlinked notebook cannot name a file outside the allowed root", async () => {
  const linked = path.join(root, "linked-project");
  fs.mkdirSync(path.join(linked, ".theta"), { recursive: true });
  fs.writeFileSync(path.join(root, "secret.jsonl"), observation("obs-9", "smuggled"));
  fs.symlinkSync(path.join(root, "secret.jsonl"), path.join(linked, ".theta", "notebook.jsonl"));
  allowFileRoot(linked);
  const response = await request(linked);
  assert.equal(response.status, 403);
});

test("a notebook created after the stream opened streams its lines as one delta", async () => {
  const first = observation("obs-1", "First hit binds");
  const s = await sse(await request(project));
  try {
    await s.waitFor("connected");
    fs.mkdirSync(path.join(project, ".theta"), { recursive: true });
    fs.writeFileSync(notebookPath, `${first}\n`);
    const append = await s.waitFor("append");
    assert.deepEqual(append.data, { lines: [first] }, "a file created after the stream started is all delta");
    const second = observation("obs-2", "Second replicate binds");
    fs.appendFileSync(notebookPath, `${second}\n`);
    const next = await s.waitFor("append");
    assert.deepEqual(next.data, { lines: [second] }, "each appended line rides exactly once");
  } finally {
    s.stop();
  }
});

test("a torn write stays invisible until its newline lands, then completes byte-exact", async () => {
  const s = await sse(await request(project));
  try {
    await s.waitFor("connected");
    const torn = observation("obs-3", "Mid-write");
    fs.appendFileSync(notebookPath, torn);
    await s.expectSilence();
    fs.appendFileSync(notebookPath, "\n");
    const append = await s.waitFor("append");
    assert.deepEqual(append.data, { lines: [torn] }, "the completed line arrives whole, never as fragments");
  } finally {
    s.stop();
  }
});

test("a rewritten file sends reset, and the pane's picture starts over", async () => {
  const s = await sse(await request(project));
  try {
    await s.waitFor("connected");
    fs.writeFileSync(notebookPath, `${observation("obs-4", "Rewritten trail")}\n`);
    await s.waitFor("reset");
  } finally {
    s.stop();
  }
});

test("a deleted watched directory closes the stream, so the client reconnects onto the new one", async () => {
  const s = await sse(await request(project));
  try {
    await s.waitFor("connected");
    fs.rmSync(path.join(project, ".theta"), { recursive: true, force: true });
    // The watched inode is dead — inotify errors, FSEvents keeps firing at
    // the ghost. Either way the stream must end: the browser's EventSource
    // reconnects, and the fresh stream re-arms on what now exists.
    await s.waitClosed();
  } finally {
    s.stop();
  }
});

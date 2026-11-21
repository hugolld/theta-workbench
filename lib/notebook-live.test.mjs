import assert from "node:assert/strict";
import test from "node:test";
import { createNotebookLive } from "./notebook-live.ts";

/** Yield until every pending microtask (the controller's loop resume) has run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A fetchSnapshot stand-in: each call is a gate the test resolves or rejects. */
function gatedFetch() {
  const calls = [];
  const fetch = (cwd) => {
    const call = { cwd, resolve: null, reject: null };
    call.done = new Promise((resolve, reject) => {
      call.resolve = (value) => resolve({ notebook: null, lines: [], ...value });
      call.reject = (error) => reject(error);
    });
    calls.push(call);
    return call.done;
  };
  return { calls, fetch };
}

/** A host that records every callback, in order. */
function recorder() {
  return {
    loading: [],
    snapshots: [],
    deltas: [],
    errors: 0,
    onLoading(value) { this.loading.push(value); },
    onSnapshot(snapshot) { this.snapshots.push(snapshot); },
    onDelta(lines) { this.deltas.push(lines); },
    onError() { this.errors += 1; },
  };
}

test("a delta racing a read discards the stale snapshot and re-reads", async () => {
  const fetcher = gatedFetch();
  const host = recorder();
  const live = createNotebookLive({ cwd: "/project", fetchSnapshot: fetcher.fetch }, host);

  const first = live.load(); // read #1 in flight
  live.delta(["{\"id\":\"obs-6\",\"type\":\"observation\"}\n"]); // races the read
  fetcher.calls[0].resolve({ lines: ["{\"id\":\"obs-1\",\"type\":\"observation\"}\n"] }); // the stale picture lands
  await tick(); // the loop sees the epoch mismatch and issues read #2

  assert.equal(fetcher.calls.length, 2, "the raced read re-ran");
  assert.deepEqual(host.snapshots, [], "the stale snapshot never applied");
  assert.deepEqual(host.deltas, [["{\"id\":\"obs-6\",\"type\":\"observation\"}\n"]], "the delta merged exactly once");

  fetcher.calls[1].resolve({
    lines: ["{\"id\":\"obs-1\",\"type\":\"observation\"}\n", "{\"id\":\"obs-6\",\"type\":\"observation\"}\n"],
  });
  await first; // load() resolves only once the re-read applied

  assert.deepEqual(host.snapshots, [{
    notebook: null,
    lines: ["{\"id\":\"obs-1\",\"type\":\"observation\"}\n", "{\"id\":\"obs-6\",\"type\":\"observation\"}\n"],
  }]);
  // The in-flight flag stays lit across the re-read — no false flicker between reads.
  assert.deepEqual(host.loading, [true, true, false]);
});

test("a newer load supersedes an older one's response", async () => {
  const fetcher = gatedFetch();
  const host = recorder();
  const live = createNotebookLive({ cwd: "/project", fetchSnapshot: fetcher.fetch }, host);

  const older = live.load();
  const newer = live.load();
  assert.equal(fetcher.calls.length, 2);

  fetcher.calls[0].resolve({ lines: ["stale"] });
  await older;
  assert.deepEqual(host.snapshots, [], "the superseded response never applied");

  fetcher.calls[1].resolve({ lines: ["fresh"] });
  await newer;
  assert.deepEqual(host.snapshots, [{ notebook: null, lines: ["fresh"] }]);
  assert.deepEqual(host.loading, [true, true, false], "the flag is owned by the newest load");
});

test("a current load's failure draws the failure and rethrows; a superseded one stays silent", async () => {
  const fetcher = gatedFetch();
  const host = recorder();
  const live = createNotebookLive({ cwd: "/project", fetchSnapshot: fetcher.fetch }, host);

  const failing = live.load();
  fetcher.calls[0].reject(new Error("HTTP 500"));
  await assert.rejects(() => failing, /HTTP 500/);
  assert.equal(host.errors, 1);
  assert.deepEqual(host.loading, [true, false]);
  assert.deepEqual(host.snapshots, []);

  // Same shape when a failure races a newer load: the newer load owns the outcome.
  const older = live.load();
  const newer = live.load();
  fetcher.calls[1].reject(new Error("HTTP 500"));
  await older; // resolves without throwing — its outcome is not its own anymore
  assert.equal(host.errors, 1, "the superseded failure never drew");
  fetcher.calls[2].resolve({ lines: ["fresh"] });
  await newer;
  assert.deepEqual(host.snapshots, [{ notebook: null, lines: ["fresh"] }]);
});

test("delta frames drop non-string entries; an empty survivor set is a no-op", async () => {
  const fetcher = gatedFetch();
  const host = recorder();
  const live = createNotebookLive({ cwd: "/project", fetchSnapshot: fetcher.fetch }, host);

  const only = live.load();
  live.delta([42, null, { bytes: 1 }]); // nothing survives: no merge, no epoch bump
  fetcher.calls[0].resolve({ lines: [] });
  await only; // applies directly — the junk frame never invalidated the read

  assert.deepEqual(host.deltas, []);
  assert.equal(fetcher.calls.length, 1, "an all-junk frame never bumps the epoch");

  live.delta(["{\"id\":\"obs-1\",\"type\":\"observation\"}\n", 7]); // the string survives, the number goes
  assert.deepEqual(host.deltas, [["{\"id\":\"obs-1\",\"type\":\"observation\"}\n"]]);
});

test("a snapshot whose lines field is not an array lands as an empty buffer", async () => {
  const fetcher = gatedFetch();
  const host = recorder();
  const live = createNotebookLive({ cwd: "/project", fetchSnapshot: fetcher.fetch }, host);

  const only = live.load();
  fetcher.calls[0].resolve({ lines: "not-an-array" });
  await only;
  assert.deepEqual(host.snapshots, [{ notebook: null, lines: [] }]);
});

test("the cwd is read when a read starts, and a switch supersedes the old project's in-flight read", async () => {
  // The pane holds ONE controller for its lifetime and hands it the current
  // cwd through a getter; this pin holds that contract. Per-cwd controllers
  // would give each project its own supersession counters, and a switch
  // would orphan the old controller's in-flight read — its snapshot would
  // then apply under the new selection.
  const fetcher = gatedFetch();
  const host = recorder();
  const cwdRef = { current: "/project-a" };
  const live = createNotebookLive({ get cwd() { return cwdRef.current; }, fetchSnapshot: fetcher.fetch }, host);

  const older = live.load();
  cwdRef.current = "/project-b";
  const newer = live.load();
  assert.deepEqual(fetcher.calls.map((call) => call.cwd), ["/project-a", "/project-b"], "each read fetched the cwd current at its start");

  fetcher.calls[0].resolve({ lines: ["{\"id\":\"obs-a\"}\n"] });
  await older;
  assert.deepEqual(host.snapshots, [], "the superseded project's snapshot never applied");

  fetcher.calls[1].resolve({ lines: ["{\"id\":\"obs-b\"}\n"] });
  await newer;
  assert.deepEqual(host.snapshots, [{ notebook: null, lines: ["{\"id\":\"obs-b\"}\n"] }]);
  assert.deepEqual(host.loading, [true, true, false]);
});

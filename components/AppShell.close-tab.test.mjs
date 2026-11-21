import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

// The close-tab fallback runs from its real bytes: the module's tab-id
// helpers and handleCloseFileTab sliced out of AppShell.tsx into a vm
// sandbox whose state setters are records (the house harness —
// AppShell.side-tabs.test.mjs, AppShell.session-delete.test.mjs).
const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

function sourceIndexOf(anchor, from = 0) {
  const at = source.indexOf(anchor, from);
  assert.notEqual(at, -1, `anchor not found: ${anchor}`);
  return at;
}
const helpersStart = sourceIndexOf("/** Panel tab id of the last sub-agent tab, or null when there is none. */");
const helpersEnd = sourceIndexOf("export function AppShell()");
const helpers = source.slice(helpersStart, helpersEnd);
const start = sourceIndexOf("  const handleCloseFileTab = useCallback(");
const end = sourceIndexOf("  // An extension's ctx.shutdown() ended the session's runtime", start);
const closeTabSource = stripTypeScriptTypes(`${helpers}\n${source.slice(start, end)}`);

/**
 * Closes `tabId` from the given tab state; the resulting state is the
 * record — `activeFileTabId` after the fallback chain ran,
 * `rightPanelOpen` after the all-empty check.
 */
function runClose(tabs, tabId) {
  const state = {
    fileTabs: tabs.fileTabs ?? [],
    terminalTabs: tabs.terminalTabs ?? [],
    notebookTabs: tabs.notebookTabs ?? [],
    agentTabs: tabs.agentTabs ?? [],
    activeFileTabId: tabs.activeFileTabId ?? null,
    rightPanelOpen: true,
  };
  const context = vm.createContext({
    useCallback: (callback) => callback,
    ...state,
    setFileTabs: (update) => { state.fileTabs = typeof update === "function" ? update(state.fileTabs) : update; },
    setTerminalTabs: (update) => { state.terminalTabs = typeof update === "function" ? update(state.terminalTabs) : update; },
    setAgentTabs: (update) => { state.agentTabs = typeof update === "function" ? update(state.agentTabs) : update; },
    setNotebookTabs: (update) => { state.notebookTabs = typeof update === "function" ? update(state.notebookTabs) : update; },
    setActiveFileTabId: (update) => { state.activeFileTabId = typeof update === "function" ? update(state.activeFileTabId) : update; },
    setRightPanelOpen: (update) => { state.rightPanelOpen = typeof update === "function" ? update(state.rightPanelOpen) : update; },
  });
  const handleCloseFileTab = vm.runInContext(`${closeTabSource}\nhandleCloseFileTab`, context);
  handleCloseFileTab(tabId);
  return state;
}

test("closing the active notebook tab falls back to the last file tab; the panel stays open", () => {
  const state = runClose({
    fileTabs: [{ id: "file-a" }, { id: "file-b" }],
    terminalTabs: [{ id: "term-1" }],
    notebookTabs: [{ cwd: "/p" }],
    activeFileTabId: "notebook:/p",
  }, "notebook:/p");
  assert.equal(state.activeFileTabId, "file-b");
  assert.equal(state.rightPanelOpen, true);
  assert.deepEqual(state.notebookTabs, []);
});

test("closing the active agent tab falls back through terminal before notebook", () => {
  const state = runClose({
    terminalTabs: [{ id: "term-1" }],
    notebookTabs: [{ cwd: "/p" }],
    agentTabs: [{ sessionId: "s1", label: "A" }, { sessionId: "s2", label: "B" }],
    activeFileTabId: "agent:s2",
  }, "agent:s2");
  assert.equal(state.activeFileTabId, "term-1");
  assert.equal(state.rightPanelOpen, true);
});

test("closing the last agent tab with no other tab closes the right panel", () => {
  // The all-empty check reads the after-close lists on every branch —
  // the agent branch once counted the closing tab itself and the panel
  // stayed open holding nothing.
  const state = runClose({
    agentTabs: [{ sessionId: "s1", label: "A" }],
    activeFileTabId: "agent:s1",
  }, "agent:s1");
  assert.equal(state.rightPanelOpen, false, "the panel closes with its last tab");
  assert.equal(state.activeFileTabId, null);
});

test("closing the last notebook tab with no other tab closes the right panel", () => {
  const state = runClose({
    notebookTabs: [{ cwd: "/p" }],
    activeFileTabId: "notebook:/p",
  }, "notebook:/p");
  assert.equal(state.rightPanelOpen, false);
});

test("closing the active file tab falls to the next file, then the other surfaces", () => {
  const state = runClose({
    fileTabs: [{ id: "file-a" }, { id: "file-b" }, { id: "file-c" }],
    activeFileTabId: "file-b",
  }, "file-b");
  assert.equal(state.activeFileTabId, "file-c");
  assert.equal(state.rightPanelOpen, true);

  const fallback = runClose({
    fileTabs: [{ id: "file-a" }],
    terminalTabs: [{ id: "term-1" }],
    notebookTabs: [{ cwd: "/p" }],
    agentTabs: [{ sessionId: "s1", label: "A" }],
    activeFileTabId: "file-a",
  }, "file-a");
  assert.equal(fallback.activeFileTabId, "term-1");
  assert.equal(fallback.rightPanelOpen, true);
});

test("closing a tab that is not the active one leaves the selection alone", () => {
  const state = runClose({
    notebookTabs: [{ cwd: "/p1" }, { cwd: "/p2" }],
    activeFileTabId: "notebook:/p1",
  }, "notebook:/p2");
  assert.equal(state.activeFileTabId, "notebook:/p1");
  assert.equal(state.rightPanelOpen, true);
});

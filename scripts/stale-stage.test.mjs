import assert from "node:assert/strict";
import test from "node:test";
import { staleStagedFiles } from "./stale-stage.mjs";

const PORCELAIN = [
	"MM lib/a.ts",
	"M  lib/b.ts",
	" M lib/c.ts",
	"MD lib/d.ts",
	"A  lib/e.ts",
	"AM lib/f.ts",
	"R  old -> new",
	"RM old2 -> new2",
	"?? lib/untracked.ts",
	"",
].join("\n");

test("a staged change paired with a worktree delta is stale", () => {
	// MM: staged-modified and worktree-modified; MD: staged-modified and
	// worktree-deleted; AM: staged-added and worktree-modified — the commit
	// ships the index version while the tree holds newer content.
	assert.deepEqual(staleStagedFiles(PORCELAIN), ["lib/a.ts", "lib/d.ts", "lib/f.ts", "old2 -> new2"]);
});

test("a clean stage or a clean worktree column is not stale", () => {
	// M-space: staged, worktree clean. Space-M: worktree-only, nothing staged.
	assert.notDeepEqual(staleStagedFiles(PORCELAIN), ["lib/b.ts", "lib/c.ts"]);
	assert.deepEqual(
		staleStagedFiles("M  lib/b.ts\n M lib/c.ts\nA  lib/e.ts"),
		[],
	);
});

test("untracked and short lines never read as stale", () => {
	assert.deepEqual(staleStagedFiles("?? lib/untracked.ts\nD \n"), []);
	assert.deepEqual(staleStagedFiles(""), []);
	assert.deepEqual(staleStagedFiles(null), []);
});

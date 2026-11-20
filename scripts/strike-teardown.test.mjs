import assert from "node:assert/strict";
import test from "node:test";
import { parseWorktrees } from "./strike-teardown.mjs";

const PORCELAIN = [
	"worktree /repo",
	"HEAD abcdef1",
	"branch refs/heads/main",
	"",
	"worktree /repo/.worktrees/t2-ceremony",
	"HEAD 1234567",
	"branch refs/heads/t2-ceremony",
	"",
	"worktree /repo/.worktrees/bare-visit",
	"HEAD abcdef1",
	"bare",
	"",
	"worktree /repo/.worktrees/detached",
	"HEAD 1234567",
	"detached",
	"",
].join("\n");

test("each worktree pairs with its checked-out branch", () => {
	const parsed = parseWorktrees(PORCELAIN);
	assert.deepEqual(parsed, [
		{ path: "/repo", branch: "refs/heads/main" },
		{ path: "/repo/.worktrees/t2-ceremony", branch: "refs/heads/t2-ceremony" },
		{ path: "/repo/.worktrees/bare-visit" },
		{ path: "/repo/.worktrees/detached" },
	]);
});

test("bare and detached entries carry no branch line", () => {
	const parsed = parseWorktrees(PORCELAIN);
	// The teardown's worktree lookup matches on branch, so a bare or
	// detached entry never reads as the branch's worktree.
	assert.equal(
		parsed.find((entry) => entry.branch === "refs/heads/t2-ceremony").path,
		"/repo/.worktrees/t2-ceremony",
	);
});

test("an empty listing parses to nothing", () => {
	assert.deepEqual(parseWorktrees(""), []);
	assert.deepEqual(parseWorktrees(null), []);
});

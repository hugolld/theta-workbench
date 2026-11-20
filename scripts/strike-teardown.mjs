#!/usr/bin/env node
// Strike teardown in one command: ends a coding strike whose PR is merged
// without replaying the wrong-branch accident class the theta-agent S4/S5
// retros seed.
//
//   node scripts/strike-teardown.mjs <branch> [base]
//
// Vendored from theta-agent's scripts/strike-teardown.mjs (the M7b-1 strike
// ceremony, ticket #2) and adapted: the merge target is a parameter — this
// campaign merges per-ticket branches into the integration branch
// m7b1-integration (local-only), so the default "main" needs an explicit
// base at teardown time:
//
//   node scripts/strike-teardown.mjs t2-ceremony m7b1-integration
//
// Run it from anywhere inside the repo — the session's shell usually stands
// in the worktree, and the anchoring survives that: the main checkout comes
// from the shared git dir, and every git call targets it with -C. The
// sequence: fetch, refuse unless the branch is merged into the base (the
// guard that licenses the -D below — plain -d compares against the remote
// topic branch, which lags the merge), fast-forward the branch the main
// checkout holds, remove the worktree, then delete the branch — last,
// because the worktree holds it checked out and the delete refuses until
// the worktree is gone. The base resolves against origin/<base> when the
// remote has it and against the local branch otherwise (the integration
// branch never needs pushing for this campaign); the main checkout may
// hold either main or the base — anything else refuses, and a held branch
// with no remote ref (a local-only integration branch) skips its
// fast-forward with a note, since the merge already landed there. A branch
// already gone locally with its remote merged is the harness
// worktree-exit having already torn down: the run finishes the shared
// steps and answers success, not refusal. No destructive mutation — the
// pull, the worktree remove, the branch delete — precedes any refusal: a
// dead network or an unmerged branch leaves the working tree exactly as
// it stood. The helpers theta-agent keeps in dogfood-gates.mjs (the shared
// spawn wrapper and the main-checkout probe) live here: this fork has one
// caller of each.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
	console.error(`strike-teardown: ${message}`);
	process.exit(1);
}

// The porcelain output pairs each worktree with its checked-out branch;
// bare and detached entries carry no branch line.
export function parseWorktrees(porcelain) {
	const out = [];
	let cur = null;
	for (const line of `${porcelain ?? ""}`.split("\n")) {
		if (line.startsWith("worktree ")) {
			cur = { path: line.slice("worktree ".length) };
			out.push(cur);
		} else if (cur !== null && line.startsWith("branch ")) {
			cur.branch = line.slice("branch ".length);
		} else if (line === "") {
			cur = null;
		}
	}
	return out;
}

function run(cmd, args) {
	return spawnSync(cmd, args, {
		encoding: "utf8",
		env: { ...process.env },
	});
}

function git(root, args) {
	const result = run("git", ["-C", root, ...args]);
	if (result.error) {
		fail(`cannot run git ${args[0]}: ${result.error.message}`);
	}
	return result;
}

function mainRepoRoot() {
	// The main checkout's root from anywhere inside the repo — the session's
	// shell usually stands in a worktree, and the shared git dir names the
	// main tree. The probe answers ".git" (relative) from the repo root and
	// the shared dir's path from a worktree: resolve against the cwd and
	// take the dirname, which is the main checkout's root either way. Null
	// when the probe fails; the caller fails on its terms.
	const probe = run("git", ["rev-parse", "--git-common-dir"]);
	if (probe.status !== 0 || probe.error) {
		return null;
	}
	const resolved = probe.stdout.trim();
	return resolved === "" ? null : path.dirname(path.resolve(process.cwd(), resolved));
}

// The merge guard in main() licenses -D: the branch is merged into the
// base, and plain -d compares against the remote topic branch, which lags
// the merge.
function deleteBranch(root, branch) {
	const deleted = git(root, ["branch", "-D", branch]);
	if (deleted.status !== 0) {
		fail(`branch delete refused: ${deleted.stderr}`);
	}
}

// The base ref to guard against: origin/<base> when the remote has it
// (canonical), the local branch otherwise (a local-only integration
// branch). Null when neither resolves — a typo'd base.
function resolveBaseRef(root, base) {
	for (const candidate of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
		if (git(root, ["rev-parse", "--verify", "--quiet", candidate]).status === 0) {
			return candidate;
		}
	}
	return null;
}

function main() {
	const branch = process.argv[2];
	const base = process.argv[3] || "main";
	if (!branch) {
		fail("usage: strike-teardown.mjs <branch> [base]");
	}
	const root = mainRepoRoot();
	if (root === null) {
		fail(`${process.cwd()} is not inside a git work tree`);
	}

	// Fetch first: the network is the one dependency, and the refusals after
	// it land before any destructive mutation.
	const fetched = git(root, ["fetch", "origin", "--prune"]);
	if (fetched.status !== 0) {
		fail(`git fetch failed — nothing changed; check the network\n${fetched.stderr}`);
	}
	const branchPresent =
		git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
	if (!branchPresent) {
		// Absent locally is often the success path wearing a refusal's
		// costume: the harness's worktree exit removes the worktree and its
		// branch before this script runs. Absent with no remote branch is a
		// typo; absent with the remote unmerged is the same refusal as below.
		if (
			git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).status !== 0
		) {
			fail(`no local branch ${branch} and no origin/${branch} — check the branch name; nothing changed`);
		}
	}
	const baseRef = resolveBaseRef(root, base);
	if (baseRef === null) {
		fail(`cannot resolve the base ${base} (no origin/${base}, no local ${base}) — check the name; nothing changed`);
	}
	const merged = git(root, [
		"merge-base",
		"--is-ancestor",
		branchPresent ? branch : `origin/${branch}`,
		baseRef,
	]);
	if (merged.status !== 0) {
		fail(
			branchPresent
				? `${branch} is not merged into ${base} — merge the PR first; nothing changed`
				: `no local branch ${branch} and origin/${branch} is not merged into ${base} — merge the PR first; nothing changed`,
		);
	}
	// The pull fast-forwards whatever the main checkout holds, so it must
	// hold main or the base — a checked-out side branch would move instead
	// (the very wrong-branch class the stray-pull accidents seeded).
	const checkedOut = git(root, ["symbolic-ref", "--short", "HEAD"]).stdout.trim();
	if (checkedOut !== "main" && checkedOut !== base) {
		fail(
			`the main checkout is on ${checkedOut}, not main or ${base} — check the strike base out first; nothing changed`,
		);
	}
	// Fast-forward the held branch from origin when the remote has it; a
	// local-only branch (this campaign's integration branch) needs no pull —
	// the merge already landed there.
	if (git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${checkedOut}`]).status === 0) {
		const pulled = git(root, ["pull", "--ff-only", "origin", checkedOut]);
		if (pulled.status !== 0) {
			fail(
				`pull --ff-only origin ${checkedOut} refused — resolve the main checkout's state first; nothing changed\n` +
				pulled.stderr,
			);
		}
	} else {
		console.log(
			`strike-teardown: no origin/${checkedOut} (local-only branch) — skipping the fast-forward pull`,
		);
	}
	const worktree = parseWorktrees(
		git(root, ["worktree", "list", "--porcelain"]).stdout,
	).find((entry) => entry.branch === `refs/heads/${branch}`);
	if (worktree !== undefined) {
		const removed = git(root, ["worktree", "remove", worktree.path]);
		if (removed.status !== 0) {
			fail(
				"worktree remove refused — a dirty worktree, a locked one, or the main working tree itself; resolve it by hand; nothing else changed\n" +
				"A lock reason naming a live session is the harness holding its own worktree: exit the worktree through the harness's own tool, then rerun — never force a removal past a live session\n" +
				removed.stderr,
			);
		}
		console.log(`strike-teardown: worktree removed (${worktree.path})`);
		// A session can be standing in its worktree when it goes away.
		console.log("strike-teardown: any shell still standing in the removed worktree must leave it");
	}
	const head = git(root, ["rev-parse", "--short", "HEAD"]).stdout.trim();
	if (branchPresent) {
		deleteBranch(root, branch);
		console.log(`strike-teardown: branch ${branch} deleted; ${checkedOut} at ${head}`);
	} else {
		console.log(
			`strike-teardown: ${branch} is already torn down — no local branch, none to delete; ${checkedOut} at ${head}`,
		);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}

import assert from "node:assert/strict";
import test from "node:test";
import {
	ciChecks,
	closesSpec,
	declaredParent,
	disclosedRanges,
	evidenceFreshness,
	uncoveredCommits,
} from "./check-strike.mjs";

// --- declaredParent: a child declares its spec in a "## Parent" section ----

test("a ## Parent section naming the spec declares the parent", () => {
	assert.equal(declaredParent("## Parent\n\n#1\n\n## What to build\n\nstuff"), "#1");
	assert.equal(declaredParent("## Parent\n#12"), "#12");
});

test("a bare mention of the spec is not a parent claim", () => {
	// #61's ready gate: a blocked-by list naming the spec must not read as a child.
	assert.equal(declaredParent("## Blocked by\n\n- #1"), null);
	assert.equal(declaredParent("This fixes #1 along the way."), null);
});

test("a body without any parent section declares nothing", () => {
	assert.equal(declaredParent(""), null);
	assert.equal(declaredParent(null), null);
});

// --- evidenceFreshness: every `clean <sha>` attestation names this HEAD ----

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

test("no attestation in the body is a pass, not a failure", () => {
	assert.deepEqual(evidenceFreshness("a chore strike with no dogfood pair", SHA_A), {
		verdict: "none",
		attested: [],
	});
	assert.deepEqual(evidenceFreshness(null, SHA_A), { verdict: "none", attested: [] });
});

test("an attestation naming HEAD is fresh", () => {
	const fresh = evidenceFreshness(`clean ${SHA_A} — rig leg and live leg`, SHA_A);
	assert.equal(fresh.verdict, "fresh");
	assert.deepEqual(fresh.attested, [SHA_A]);
});

test("an attestation naming any other sha is stale", () => {
	assert.equal(evidenceFreshness(`clean ${SHA_B}`, SHA_A).verdict, "stale");
	// Two attestations naming the same stale sha stay stale.
	assert.equal(evidenceFreshness(`clean ${SHA_B}\nclean ${SHA_B}`, SHA_A).verdict, "stale");
	// Two attestations disagreeing with each other are stale even if one matches.
	assert.equal(evidenceFreshness(`clean ${SHA_A}\nclean ${SHA_B}`, SHA_A).verdict, "stale");
});

test("prose containing the word clean never attests", () => {
	// Only the 40-hex token is an attestation; "clean tree" is prose.
	assert.equal(evidenceFreshness("clean tree, clean worktree", SHA_A).verdict, "none");
	assert.equal(evidenceFreshness(`clean ${"z".repeat(7)}`, SHA_A).verdict, "none");
});

// --- ciChecks: parse gh pr checks' tab-separated table ---------------------

test("every check passing is green", () => {
	const green = ciChecks("lint\tpass\t100s\thttps://ci\ntest\tpass\t240s\thttps://ci");
	assert.equal(green.verdict, "green");
	assert.deepEqual(green.offenders, []);
});

test("any non-pass row is red, pending included", () => {
	const red = ciChecks("lint\tpass\t100s\thttps://ci\ntest\tfail\t240s\thttps://ci");
	assert.equal(red.verdict, "red");
	assert.deepEqual(red.offenders, ["test (fail)"]);
	const pending = ciChecks("e2e\tpending\t0s\thttps://ci");
	assert.equal(pending.verdict, "red");
	assert.deepEqual(pending.offenders, ["e2e (pending)"]);
	// "skipping" rows are parseable statuses and count as not green.
	const skipped = ciChecks("deploy\tskipping\t0s\thttps://ci");
	assert.equal(skipped.verdict, "red");
});

test("no parseable rows is none, not green", () => {
	assert.equal(ciChecks("").verdict, "none");
	assert.equal(ciChecks("gh: no checks reported on this branch\n").verdict, "none");
	assert.equal(ciChecks(null).verdict, "none");
});

// --- disclosedRanges: the reviewed: line grammar ---------------------------

test("a bare reviewed range parses base-exclusive", () => {
	assert.deepEqual(disclosedRanges("reviewed: 1234567..89abcde"), [
		{ base: "1234567", head: "89abcde" },
	]);
});

test("a lone sha names one commit", () => {
	assert.deepEqual(disclosedRanges("reviewed: 1234567"), [{ base: null, head: "1234567" }]);
});

test("indent and one list marker ride along", () => {
	assert.deepEqual(disclosedRanges("- reviewed: 1234567..89abcde"), [
		{ base: "1234567", head: "89abcde" },
	]);
	assert.deepEqual(disclosedRanges("  > reviewed: 1234567..89abcde"), [
		{ base: "1234567", head: "89abcde" },
	]);
});

test("decorated ranges — bold, backticks — count as nothing", () => {
	// The S3 retro: a decorated body parses to zero ranges and the gate must
	// say so, not silently accept decoration.
	assert.deepEqual(disclosedRanges("**reviewed:** 1234567..89abcde"), []);
	assert.deepEqual(disclosedRanges("`reviewed: 1234567..89abcde`"), []);
});

test("prose without a hex token matches nothing", () => {
	assert.deepEqual(disclosedRanges("reviewed the diff in two rounds"), []);
	// "unreviewed:" does not match — the literal must start the token.
	assert.deepEqual(disclosedRanges("unreviewed: 1234567"), []);
});

test("fenced code blocks are examples, not disclosures", () => {
	const body = "see the syntax:\n\n```\nreviewed: 1234567..89abcde\n```\n";
	assert.deepEqual(disclosedRanges(body), []);
});

test("hex shas normalize to lowercase", () => {
	assert.deepEqual(disclosedRanges("reviewed: ABCDEF1..0ABCDEF"), [
		{ base: "abcdef1", head: "0abcdef" },
	]);
});

// --- uncoveredCommits: the set difference, in branch order -----------------

test("commits no resolved range covers are uncovered, newest first", () => {
	const branch = ["c3", "c2", "c1"];
	assert.deepEqual(uncoveredCommits(branch, ["c1"]), ["c3", "c2"]);
	assert.deepEqual(uncoveredCommits(branch, ["c1", "c2", "c3"]), []);
	assert.deepEqual(uncoveredCommits(branch, []), branch);
});

// --- closesSpec: the closing-keyword grammar -------------------------------

test("each closing keyword form names the spec", () => {
	for (const keyword of [
		"Closes #2",
		"close #2",
		"Fixes #2",
		"resolved #2",
		`Resolves hugolld/theta-workbench#2`,
		`fixes https://github.com/hugolld/theta-workbench/issues/2`,
	]) {
		assert.equal(closesSpec(`summary line\n\n${keyword}`, 2), true, keyword);
	}
});

test("a prose mention, a fenced example, and a wrong number do not close", () => {
	assert.equal(closesSpec("this PR is part of #2", 2), false);
	assert.equal(closesSpec("```\nCloses #2\n```", 2), false);
	assert.equal(closesSpec("Closes #3", 2), false);
	// Another repo's issue reference closes that repo's issue, never this one.
	assert.equal(closesSpec("Closes other-owner/other-repo#2", 2), false);
});

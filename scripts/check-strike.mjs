// Strike-completeness gate: before a strike's PR goes ready, every child
// of the spec issue must be landed on this branch (a commit referencing
// its number) or already closed. A closeout ticket — the merge/publish
// steps that run after the merge — is the expected open exception.
//
// Vendored from theta-agent's scripts/check-strike.mjs (the M7b-1 strike
// ceremony, ticket #2) and adapted: the tracker repo is this fork, and the
// branch base is the PR's own base branch — this campaign strikes onto the
// integration branch m7b1-integration, so the child walk and the review
// coverage run against `origin/<base>` (falling back to the local branch
// when the base is local-only), not a hardcoded origin/main. With no PR,
// the fallback base is origin/main.
//
// Evidence freshness: when the PR body carries a dogfood attestation
// (`clean <sha>` — the 40-hex grammar below; theta-agent exports the same
// pattern from its audit-dogfood.mjs auditor, which this fork does not
// ship yet, so the grammar lives here), that SHA must equal HEAD. Evidence
// goes stale on the next commit, and a stale pair must be recaptured, not
// re-bound. No attestation in the body (chore strikes) passes with a note.
//
// CI green: every check `gh pr checks` lists for the branch must pass.
// Pending counts as not green: the gate runs at ready/merge time, where
// pending means wait. The fork's ci.yml runs lint, tsc, the test suite,
// and the e2e lane on every PR — the suite that the local pre-commit hook
// does not run by default binds here.
//
// Review coverage: a ready PR's review rounds must cover the branch. The
// body carries one `reviewed: <base>..<head>` line per round (hex shas,
// base exclusive; a lone sha names one commit), and any branch commit no
// disclosed range covers reds the gate. Draft PRs skip with a note — the
// final pass precedes ready, by construction.
//
// Spec close: a ready PR's body must carry a closing keyword for its own
// spec (`Closes #<spec>`, any of GitHub's nine keyword forms).
//
// Usage: node scripts/check-strike.mjs <spec-issue-number>
// A childless issue is a maintenance strike: no children to land, and the
// evidence-freshness, review-coverage, spec-close, and CI-green gates
// still run.
// Exit 0 = complete (or only expected exceptions remain); 1 = a child is
// open with no branch commit, attested evidence is stale, a ready PR's
// review disclosure leaves branch commits uncovered, a ready PR's body
// does not close its spec, or a PR check is non-pass; 2 = usage or
// tracker error.
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = "hugolld/theta-workbench";

// The dogfood attestation grammar — see the header comment for why it is
// defined here rather than imported from an auditor module.
const CLEAN_LINE_PATTERN = /\bclean\s+([0-9a-f]{40})\b/g;

// The pure half of the evidence-freshness gate: every `clean <sha>`
// attestation in the PR body must name the branch HEAD. Prose "clean"
// never matches — only the 40-hex token does — and no attestation at all
// is a pass (chore strikes carry no dogfood pair), not a failure.
export function evidenceFreshness(prBody, head) {
	const attested = [
		...`${prBody ?? ""}`.matchAll(CLEAN_LINE_PATTERN),
	].map((match) => match[1]);
	if (attested.length === 0) return { verdict: "none", attested };
	const unique = [...new Set(attested)];
	return unique.length === 1 && unique[0] === head
		? { verdict: "fresh", attested: unique }
		: { verdict: "stale", attested: unique };
}

// The pure half of child detection: a child declares its spec in a
// "## Parent" section naming the issue number. A bare mention elsewhere
// — a blocked-by list, a PR reference — is not a parent claim.
export function declaredParent(body) {
	const section = /^## Parent\s*\n\s*#(\d+)\b/m.exec(`${body ?? ""}`);
	return section ? `#${section[1]}` : null;
}

// The pure half of the CI gate: parse `gh pr checks` output (tab-separated
// name/status/elapsed/url rows; statuses pass, fail, pending, skipping).
// Any non-pass row is red; zero parseable rows is a none (no PR yet, or gh
// failed) — the gate protects check runs that exist, same as attestations.
export function ciChecks(output) {
	const rows = `${output ?? ""}`
		.split("\n")
		.map((line) => line.split("\t"))
		.filter((cols) => ["pass", "fail", "pending", "skipping"].includes(cols[1]));
	const offenders = rows
		.filter((cols) => cols[1] !== "pass")
		.map((cols) => `${cols[0]} (${cols[1]})`);
	return {
		verdict: rows.length === 0 ? "none" : offenders.length === 0 ? "green" : "red",
		offenders,
	};
}

// The pure half of the review-coverage gate: parse the body's review-round
// disclosures. One line per round — `reviewed: <base>..<head>` (hex shas,
// base exclusive) or `reviewed: <head>` (a lone sha names one commit).
// List markers and trailing prose ride along; prose without a hex token
// ("reviewed the diff") matches nothing, and "unreviewed:" does not match
// — the literal must start the token. More than one range per line does
// not parse (one line per round): under-covering fails loudly at the
// set-difference half, never silently. Fenced code blocks are stripped
// first: a body that documents the syntax with real shas is an example,
// not a disclosure. Hex shas are canonical lowercase in git; the
// case-insensitive match accepts what a hand writes, and the capture
// normalizes so resolution against rev-list's lowercase output holds.
const REVIEWED_LINE =
	/^[^\S\n]*(?:[-*+]\s+|>\s+)?reviewed:?\s+([0-9a-f]{7,40})(?:\.\.([0-9a-f]{7,40}))?\b/gim;

// Fenced code blocks are prose examples, not disclosures: strip them
// before a body parses (both body-parsing gates share the rule).
function unfencedBody(body) {
	return `${body ?? ""}`.replace(/```[\s\S]*?```/g, "");
}

export function disclosedRanges(prBody) {
	const unfenced = unfencedBody(prBody);
	return [...unfenced.matchAll(REVIEWED_LINE)].map((m) => ({
		base: m[2] === undefined ? null : m[1].toLowerCase(),
		head: (m[2] === undefined ? m[1] : m[2]).toLowerCase(),
	}));
}

// The pure half of the set difference: branch commits no resolved range
// covers, in branch order (rev-list's newest-first).
export function uncoveredCommits(branchCommits, covered) {
	const coveredSet = new Set(covered);
	return branchCommits.filter((sha) => !coveredSet.has(sha));
}

// The pure half of the spec-close gate: GitHub auto-closes the spec issue
// only when the merged PR's body carries a closing keyword naming it —
// `Closes #<n>` in any of GitHub's nine keyword forms, or the same keyword
// on this repo's `owner/repo#<n>` or issue-URL reference (a reference
// pointing at another repo closes that repo's issue, never this one, so
// only this repo's forms count). A prose mention does not close, and a
// fenced example is not a close (an example is not a disclosure).
const CLOSING_KEYWORD = new RegExp(
	`\\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\\s+(?:#(\\d+)|${repo}#(\\d+)|https://github\\.com/${repo}/issues/(\\d+))\\b`,
	"gi",
);

export function closesSpec(prBody, spec) {
	return [...unfencedBody(prBody).matchAll(CLOSING_KEYWORD)].some(
		(match) => match[1] === `${spec}` || match[2] === `${spec}` || match[3] === `${spec}`,
	);
}

function main(argv) {
	const spec = argv[0];
	if (!spec || !/^\d+$/.test(spec)) {
		console.error("usage: node scripts/check-strike.mjs <spec-issue-number>");
		return 2;
	}
	const run = (cmd) => {
		try {
			// stderr is piped, not inherited: a failed gh call (no PR yet, no
			// network) must read as an empty string, not dump usage help.
			return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			// A non-zero exit can still carry the wanted stdout: gh pr checks
			// exits 1 on a failing check and 8 on pending, table intact.
			return (error.stdout ?? "").toString();
		}
	};

	const branch = run("git branch --show-current").trim();
	// The remote's default branch, without a second gh call; "main" covers
	// clones where origin/HEAD is unset. A gate run from the default branch
	// finds no PR by design — the misleading "no PR body" note sent a session
	// to debug the wrong thing, so the no-PR notes name that cause.
	const defaultBranch = (
		run("git symbolic-ref --short refs/remotes/origin/HEAD").trim().replace(/^origin\//, "") ||
		"main"
	);
	// One gh call for all PR reads (body, draft state, base branch): a second
	// probe could fail transiently after this one succeeded and misread a
	// live PR as "no PR available". gh pr view needs the branch spelled out
	// when --repo is passed (it cannot infer "current branch" across an
	// explicit repository).
	const prJson = run(`gh pr view --repo ${repo} ${branch} --json body,isDraft,baseRefName`);
	let prBody = "";
	let isDraft = "";
	let prBase = "";
	try {
		const parsed = JSON.parse(prJson);
		prBody = typeof parsed.body === "string" ? parsed.body : "";
		isDraft = parsed.isDraft === true ? "true" : parsed.isDraft === false ? "false" : "";
		prBase = typeof parsed.baseRefName === "string" ? parsed.baseRefName : "";
	} catch {
		// gh failed or printed nothing: no PR (or no network) — the gates
		// below read their own hasPr/isDraft and skip with their notes.
	}

	// The strike's base ref: the PR's own base branch when a PR exists (this
	// campaign merges per-ticket branches into m7b1-integration), else the
	// remote's default branch. The remote ref wins when it exists — the
	// campaign's integration branch may be local-only, and a base that
	// resolves to nothing is a gate error, not silently empty coverage.
	const baseName = prBase || defaultBranch;
	let resolvedBase = null;
	for (const candidate of [`refs/remotes/origin/${baseName}`, `refs/heads/${baseName}`]) {
		if (run(`git rev-parse --verify --quiet ${candidate}`).trim() !== "") {
			resolvedBase = candidate;
			break;
		}
	}
	if (resolvedBase === null) {
		console.error(`cannot resolve the strike base ${baseName} (no origin/${baseName}, no local ${baseName})`);
		return 2;
	}

	// Children declare their parent ("## Parent" naming the spec number) —
	// only that section counts, per declaredParent above.
	const issues = run(
		`gh issue list --repo ${repo} --state all --limit 200 --json number,title,state,body`,
	);
	if (!issues) {
		console.error(`cannot list issues on ${repo} — is gh authenticated?`);
		return 2;
	}
	const listed = JSON.parse(issues);
	// The childless pass below must not mistake a truncated listing for an
	// empty one: children past the limit would read as a maintenance strike.
	if (listed.length >= 200) {
		console.error("issue list hit the --limit 200 window — raise the limit in check-strike.mjs");
		return 2;
	}
	const children = listed.filter((i) => declaredParent(i.body) === `#${spec}`);
	if (children.length === 0) {
		// A childless issue is a maintenance strike: the child loop below
		// no-ops; the evidence, coverage, spec-close, and CI gates still run.
		console.log(
			`no issues name #${spec} as parent — maintenance strike; the remaining gates still run.`,
		);
	}

	// A child is landed when some commit on this branch references its number.
	const branchLog = run(`git log --oneline ${resolvedBase}..HEAD`);
	let missing = 0;
	for (const i of children) {
		const landed = new RegExp(`#${i.number}\\b`).test(branchLog);
		if (i.state.toUpperCase() === "CLOSED" || landed) {
			console.log(`ok   #${i.number} ${i.title} (${i.state})`);
			continue;
		}
		if (/closeout/i.test(i.title)) {
			console.log(`skip #${i.number} ${i.title} (closeout runs post-merge)`);
			continue;
		}
		console.log(`MISSING #${i.number} ${i.title} — open, no branch commit`);
		missing += 1;
	}
	if (missing > 0) {
		console.error(`\n${missing} child issue(s) not landed; see above.`);
		return 1;
	}

	// Evidence freshness: the PR body's dogfood attestation must name this
	// HEAD. A body with no attestation, or no PR yet, passes with a note —
	// the gate protects evidence that exists, it does not demand evidence.
	const head = run("git rev-parse HEAD").trim();
	const freshness = evidenceFreshness(prBody, head);
	if (freshness.verdict === "stale") {
		console.error(
			`\nstale evidence: PR body attests ${freshness.attested.join(", ")} ` +
				`but HEAD is ${head} — recapture the dogfood pair at the final ` +
				"HEAD (the batch rule in docs/agents/strikes.md).",
		);
		return 1;
	}
	if (freshness.verdict === "fresh") {
		console.log(`\nevidence fresh: PR body attests ${head}.`);
	} else if (prBody) {
		console.log(
			"\nno dogfood attestation in the PR body — the gate hunts the `clean <sha>` verdict token, " +
				"so live-leg-only and chore strikes pass here by design; freshness check skipped.",
		);
	} else if (branch === defaultBranch) {
		console.log(
			`\nno PR on the default branch (${branch}) — the gate reads the strike's ` +
				"PR; run it from the strike worktree.",
		);
	} else {
		console.log(
			"\nno PR body available (no PR, empty body, or detached HEAD) — freshness check skipped.",
		);
	}

	// Review coverage: at ready time every branch commit must sit under a
	// disclosed `reviewed: <base>..<head>` range. A draft PR skips with a
	// note — the final pass discloses before ready, by construction.
	// Singles and ranges resolve to full shas against the branch (prefix
	// match; ranges via rev-list), and a disclosure that resolves to
	// nothing is a typo, red, not silently empty coverage.
	const hasPr = isDraft === "true" || isDraft === "false";
	if (hasPr && isDraft === "true") {
		console.log(
			"\nreview coverage: skipped while the PR is draft — the final pass discloses before ready.",
		);
	} else if (hasPr) {
		const branchCommits = run(`git rev-list ${resolvedBase}..HEAD`)
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean);
		const ranges = disclosedRanges(prBody);
		const covered = new Set();
		const unresolved = [];
		for (const r of ranges) {
			if (r.base === null) {
				const full = branchCommits.find((c) => c.startsWith(r.head));
				if (full) {
					covered.add(full);
				} else {
					unresolved.push(r.head);
				}
				continue;
			}
			const resolved = run(`git rev-list ${r.head} --not ${r.base}`)
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean);
			if (resolved.length === 0) {
				unresolved.push(`${r.base}..${r.head}`);
				continue;
			}
			for (const c of resolved) covered.add(c);
		}
		if (unresolved.length > 0) {
			console.error(
				`\nreview coverage: disclosed range(s) ${unresolved.join(", ")} do not resolve on this branch — ` +
					"fix the disclosure (one line per round: `reviewed: <base>..<head>`).",
			);
			return 1;
		}
		const uncovered = uncoveredCommits(branchCommits, [...covered]);
		if (uncovered.length > 0) {
			if (ranges.length === 0) {
				// A decorated body (bold labels, backticked ranges) parses to
				// zero ranges and the uncovered-commits list would be
				// indistinguishable from genuinely missing disclosures. Name
				// the format contract instead.
				console.error(
					`\nreview coverage: the PR body parses to zero \`reviewed:\` ranges, so all ` +
						`${uncovered.length} branch commit(s) sit uncovered — the gate reads only ` +
						"lines that START with `reviewed: <base>..<head>` (indent and one list " +
						"marker are fine); ranges wrapped in markdown decoration — bold, " +
						"backticks — count as nothing. Move each range onto its own bare line " +
						"and rerun.",
				);
				return 1;
			}
			const named = run(`git log --no-walk --format='%h %s' ${uncovered.join(" ")}`).trim();
			console.error(
				`\nreview coverage: ${uncovered.length} commit(s) not under any disclosed ` +
					"`reviewed:` range —\n" +
					`${named}\n` +
					"disclose each review round in the PR body as `reviewed: <base>..<head>` " +
					"(hex shas, base exclusive) and rerun.",
			);
			return 1;
		}
		console.log(
			`\nreview coverage: every branch commit sits under a disclosed reviewed range (${ranges.length} disclosed).`,
		);
	} else if (branch === defaultBranch) {
		console.log(
			`\nno PR on the default branch (${branch}) — the coverage gate reads the strike's PR; ` +
				"run it from the strike worktree.",
		);
	} else {
		console.log("\nreview coverage: no PR available (no PR yet) — skipped.");
	}

	// Spec close: a ready PR's body must carry a closing keyword for its
	// own spec, or the merge leaves the issue open for a hand-paid close
	// nobody owns — an open spec misleads the routing read and this gate's
	// own child walk. A draft skips with a note: the final body carries the
	// keyword before ready.
	if (hasPr && isDraft === "true") {
		console.log(
			"\nspec close: skipped while the PR is draft — the ready body carries `Closes #<spec>`.",
		);
	} else if (hasPr) {
		if (!closesSpec(prBody, spec)) {
			console.error(
				`\nspec close: the PR body does not close #${spec} — GitHub auto-closes the spec only on ` +
					`a closing keyword in the merged body (\`Closes #${spec}\`, any of the nine keyword ` +
					"forms, or the same keyword on this repo's `owner/repo#<n>` or issue-URL reference); " +
					"a prose mention does not close. Add the line and rerun.",
			);
			return 1;
		}
		console.log(`\nspec close: the PR body closes #${spec} on merge.`);
	} else {
		console.log("\nspec close: no PR available — skipped.");
	}

	// CI green: every check the PR reports must pass at this HEAD. gh's exit
	// code mixes fail and pending, so the table is parsed instead — pending
	// blocks the same way fail does at ready/merge time.
	const ci = ciChecks(run(`gh pr checks --repo ${repo} ${branch}`));
	if (ci.verdict === "red") {
		console.error(
			`\nCI not green: ${ci.offenders.join(", ")} — fix the failure or ` +
				"let the run finish before ready/merge.",
		);
		return 1;
	}
	if (ci.verdict === "green") {
		console.log("\nCI green: every PR check passes.");
	} else if (branch === defaultBranch) {
		console.log(
			`\nno PR checks on the default branch (${branch}) — run the gate from the ` +
				"strike worktree.",
		);
	} else {
		console.log("\nno PR checks available (no PR yet, or gh failed) — CI check skipped.");
	}
	console.log(
		children.length === 0
			? "\nstrike complete: no children to land (maintenance strike)."
			: "\nstrike complete: every child is landed or closed.",
	);
	return 0;
}

if (
	process.argv[1] !== undefined &&
	fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
	// process.exit truncates piped stdout on macOS; exitCode lets Node flush.
	process.exitCode = main(process.argv.slice(2));
}

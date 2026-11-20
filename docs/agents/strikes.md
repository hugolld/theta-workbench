# Strikes: the campaign workflow for this fork

One ticket, one branch, one PR. The ceremony is vendored from theta-agent
(the M7b-1 strike, ticket #2) and adapted to this tracker. It exists so a
strike cannot silently skip its review, its evidence, or its CI.

## The shape

- **One strike per ticket.** Branch off the milestone's integration branch.
  During M7b-1 that branch is `m7b1-integration`: per-ticket branches merge
  into it, and it merges into `main` when the milestone closes. Worktrees
  live under `.worktrees/` so `node_modules` resolves from the checkout root.
- **Draft PR early.** Open the draft against `m7b1-integration` on the first
  commit. Run the gate at draft time too — a gate defect surfaces cheapest
  while the strike is small.
- **Review before capture.** The review round runs while the tree is cheap
  to change; the dogfood evidence is captured once, at the final HEAD. The
  reverse order pays a full recapture every time a review fix moves HEAD.
- **Closeout.** Refresh the PR body, disclose each review round, mark ready,
  merge, then tear down:
  `node scripts/strike-teardown.mjs <branch> m7b1-integration`.

## The gate

`node scripts/check-strike.mjs <spec-issue-number>` — run from the strike
worktree. Exit 0 means the strike may go ready; exit 1 refuses with the
offender named; exit 2 is a usage or tracker error. The legs:

| Leg | Refuses when |
| --- | --- |
| Child walk | An open child of the spec has no branch commit naming it (`#<n>` in the subject). A closeout-titled child is the expected exception; a childless spec is a maintenance strike and skips this leg. |
| Evidence freshness | The PR body attests `clean <sha>` at any SHA but HEAD. Evidence goes stale on the next commit — recapture the pair, never re-bind the words. |
| Review coverage | A ready PR's commits are not all covered by `reviewed: <base>..<head>` lines (hex shas, base exclusive; a lone sha names one commit). One bare line per round in the body; markdown decoration counts as nothing. Draft PRs skip this leg. |
| Spec close | A ready PR's body lacks a closing keyword for its spec (`Closes #<spec>`). Draft PRs skip this leg. |
| CI green | Any check `gh pr checks` reports is not passing — pending included. The leg protects checks that exist: until the fork's Actions workflows are enabled (a one-time owner act in the GitHub UI — they ship with the upstream history but never registered on this fork), `gh pr checks` reports none and this leg skips with a note; the fail/pending parsing is pinned in `scripts/check-strike.test.mjs`. |

The branch base is the PR's own base branch (`origin/<base>`, falling back
to the local branch), so coverage and the child walk read exactly the
strike's own commits — the integration branch's history never enters.

A product-free chore strike may prove the gate on a scratch draft PR;
close the PR and delete its branch after the run.

## Evidence and dogfood

Acceptance is met on captured evidence — session transcripts, recordings,
exit statuses — never on the model's self-report. The PR body's attestation
carries the `clean <40-hex-sha>` verdict token; the gate holds it against
HEAD. Capture at the final HEAD, after the last review fix.

## The pre-commit hook

Enable it per clone (it covers every worktree of the clone):

```bash
git config core.hooksPath .githooks
```

It runs `npm run lint` and `npx --no-install tsc --noEmit`, and warns on a
stale staged snapshot (`scripts/stale-stage.mjs` — a warning, never a
refusal). The full test suite does not run by default: several tests read
the host's own pi state or resolve `node_modules` from the checkout root,
so they red on any host whose state differs and inside a nested worktree.
The suite binds at PR time instead — `.github/workflows/ci.yml` runs lint,
tsc, the suite, and e2e on every pull request, and the gate's CI leg
refuses a ready PR whose checks are not all green. Set
`THETA_PRECOMMIT_TEST=1` to run the suite locally anyway.

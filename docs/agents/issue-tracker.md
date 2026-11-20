# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues on
`hugolld/theta-workbench`. Use the `gh` CLI for all operations. Vendored
from theta-agent's `docs/agents/issue-tracker.md` and adapted to this
tracker (the M7b-1 strike, ticket #2).

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Spec and child grammar**: a spec issue holds the campaign's design; each ticket declares its spec in a `## Parent` section naming the issue number (`scripts/check-strike.mjs` reads exactly that section — a bare mention elsewhere, a blocked-by list included, is not a parent claim).
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels. On this network the rendered view is the flaky path — it can stall or answer empty with exit 0; when it does, read the issue through the API instead: `gh api repos/hugolld/theta-workbench/issues/<number> --jq .body`, and the `.../issues/<number>/comments` endpoint for comments.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."` — or let the merged PR's `Closes #<n>` line do it (the gate's spec-close leg checks the keyword before ready).

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Blocking and child tickets

GitHub's **native issue dependencies** are the canonical, UI-visible blocking representation. Add an edge with `gh api --method POST repos/hugolld/theta-workbench/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/hugolld/theta-workbench/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.

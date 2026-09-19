# agent-janitor

Deterministic lifecycle management for AI-agent artifacts in git repositories.

agent-janitor finds the debris that spec/plan-mode agent workflows leave behind — plan documents, handoff notes, scratch scripts, research notes — decides what can safely be removed using **pure git logic**, and executes the cleanup through a **reviewable, evidence-backed plan**. It makes **zero LLM calls**.

```bash
$ agent-janitor scan
PATH                         CATEGORY         VERDICT         AGE(d)  REFS
HANDOFF-notes.md             plan-docs        recent          1       0
plans/auth-refactor.plan.md  plan-docs        needs-review    40      1
plans/feature-x.plan.md      plan-docs        safe-to-remove  40      0
scripts/scratch-cleanup.py   scratch-scripts  safe-to-remove  40      0
scripts/scratch-keep.js      scratch-scripts  keep            40      1
docs/architecture.md         custom           protected       40      1
```

## Why: the cleanup problem nobody solved

Teams running spec/plan-mode agent workflows for weeks accumulate a surprising amount of residue:

- `.agents/plans/` and `.claude/plans/` directories full of plan documents
- `*.plan.md`, `PLAN*.md` and `HANDOFF*.md` files scattered through the tree
- agent-written "temporary" scripts (`scratch-migrate.py`, `tmp-fix.sh`, `one-off.cjs`) that were never temporary

An Ask HN thread in September 2026 asked how people deal with this and got no good answer. The obvious idea — "just ask an agent to clean it up" — is exactly the wrong one. After the "Claude Code wiped his Mac" class of incidents, people are (rightly) afraid to hand an autonomous agent a broom and a delete key. An LLM deciding what to delete is non-deterministic, unauditable, and one prompt-injection away from a bad day.

agent-janitor takes the opposite position: **cleanup must be deterministic**.

- No LLM in the loop. Every decision comes from git history and file contents.
- Every item gets a verdict backed by evidence you can check yourself (references, commit age, merge history).
- Nothing happens without a generated plan file that a human can read, diff, and re-verify.
- All mutations are git operations (`git mv` / `git rm`), left staged for review — never pushed, never force-anything.
- The default action is **archive**, not delete.

## What it detects

| Category | Built-in conventions |
|---|---|
| `plan-docs` | `.agents/plans/**`, `.claude/plans/**`, `plans/**`, `docs/plans/**`, `**/*.plan.md`, `PLAN*.md`, `HANDOFF*.md`, `.handoff/**` |
| `scratch-scripts` | Tracked-name convention `(scratch\|temp\|tmp\|oneoff\|one-off\|throwaway)` as a delimited token in the file name (`.js .mjs .cjs .ts .py .sh .ps1 .cmd` only), in any directory |
| `custom` | Anything you add via `categories.custom.include` in the config |

Globs follow gitignore-style semantics: a pattern without `/` matches the file name at any depth; `**` matches zero or more path segments. `.git/`, `node_modules/` and `.agent-janitor/` are always excluded from detection.

## Install

Requires Node 20+ and git.

```bash
npm install -g agent-janitor
# or run ad hoc:
npx agent-janitor scan
```

## Workflow

```
scan -> plan -> human review -> verify-plan -> apply -> commit
```

1. **`agent-janitor scan [path]`** — inventory every artifact with category, verdict, age and reference count. Add `--format json` for machine-readable output.
2. **`agent-janitor plan [path]`** — write `.agent-janitor/plan-<yyyyMMdd-HHmmss>.json` plus a human-readable `.agent-janitor/cleanup-plan.md`, grouped by verdict with evidence per item. Always exits 0; a plan is informational.
3. **Human review** — read `cleanup-plan.md`. Disagree with a verdict? Protect the path in `agent-janitor.yaml` and regenerate.
4. **`agent-janitor verify-plan <file>`** — the CI/reviewer re-check. Re-runs every check against the current worktree and exits 1 if anything changed since the plan was generated (file changed, new references appeared, verdict regressed). Run it right before applying, or in CI on the review PR.
5. **`agent-janitor apply --plan <file>`** — execute the plan. Default mode `archive` moves items with `git mv` into `.agent-janitor/archive/<yyyyMMdd>/` preserving relative subpaths; `--mode delete` uses `git rm`. Only `safe-to-remove` items are touched (`--include-review` also takes `needs-review` items). Changes are left staged for you to commit.
6. **Commit** the result like any other change. Revertible with plain git.

## Commands

```
agent-janitor scan [path] [--format table|json] [--config <file>]
agent-janitor plan [path] [--config <file>]
agent-janitor apply --plan <file> [--mode archive|delete] [--include-review] [--dry-run] [--fresh]
agent-janitor verify-plan <file>
```

| Flag | Applies to | Meaning |
|---|---|---|
| `--config <file>` | scan, plan | Config file (default: `./agent-janitor.yaml` if present) |
| `--format table\|json` | scan | Output format |
| `--mode archive\|delete` | apply | `archive` (default) = `git mv` into the archive dir; `delete` = `git rm` |
| `--include-review` | apply | Also apply `needs-review` items (never `protected`/`keep`/`recent`) |
| `--dry-run` | apply | Print every action without executing it |
| `--fresh` | apply | Allow applying a plan older than 24 hours |

`apply` refuses plans older than 24 hours unless `--fresh` is passed — stale plans are how mistakes happen. Untracked files are never applied (they carry no git history; `ageDays 0` also keeps them out of the eligible set in practice).

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (including `plan`, which never fails the build) |
| 1 | Refused or failed: stale plan, stale verification, git failure, plan root invalid |
| 2 | Usage or configuration error (unknown command, invalid config or plan file, not a git repository) |

## Verdict matrix

Checks run in a fixed order; the first match wins. This ordering is the whole contract.

| # | Condition | Verdict |
|---|---|---|
| 1 | Path is listed in `protected` | `protected` |
| 2 | Referenced by at least one code-ish file | `keep` |
| 3 | Last touched `ageDays < minAgeDays` (default 14) | `recent` |
| 4 | Referenced by docs/other files | `needs-review` |
| 5 | Plan doc whose task commit is an ancestor of HEAD, and zero references | `safe-to-remove` |
| 6 | Zero references and `ageDays >= minAgeDays` | `safe-to-remove` |
| 7 | Anything else | `needs-review` |

## Evidence

Every verdict ships with its evidence, both in the JSON plan and in `cleanup-plan.md`:

- **references** — every other worktree file is scanned for a plain substring occurrence of the artifact's basename or repo-relative path (CRLF-tolerant, binaries and `.agent-janitor/` skipped, the artifact itself excluded). Referrers are classified as code / docs / other, and up to 3 example locations are recorded as `path:line`. A mention in prose counts: `see notes.tmp.md for details` makes `notes.tmp.md` a `needs-review`, not a `safe-to-remove`.
- **age** — days since the last commit touching the file (`git log -1 --format=%ct -- <path>`). Never-committed (staged/untracked) artifacts get `ageDays 0` plus a `neverCommitted` flag.
- **task-merged** (plan docs only) — a commit whose message mentions the plan's stem (case-insensitive fixed-string match, `*.plan.md` also matches the name without `.plan`) exists in history reachable from HEAD — i.e. the described task was merged, not abandoned on a branch. The matching commit subject is recorded as evidence.

## Configuration

`agent-janitor.yaml` in the repo root (or `--config <file>`). Absent file means defaults.

```yaml
# Days after which an unreferenced artifact may be considered old. Default 14.
minAgeDays: 14

# Where archived files go. Must be relative; keep it under .agent-janitor/
# so archived items never re-appear in scans. Default .agent-janitor/archive
archiveDir: .agent-janitor/archive

# Paths that are never removable. Exact path or directory prefix.
protected:
  - docs/architecture.md
  - plans/keep/**

categories:
  plan-docs:        # add or exclude globs on top of the built-in conventions
    include:
      - "notes/**/*.plan.md"
    exclude:
      - plans/keep-this.md
  scratch-scripts:
    exclude:
      - scripts/canonical-scratch-loader.js
  custom:           # your own additions, any file type
    include:
      - "research/**"
      - "**/*.session-notes.md"
    exclude: []
```

All validation problems are reported together (accumulated errors, exit 2) — no fail-fast typos.

## Threat model: what agent-janitor will never do

- **Never delete anything without a generated plan file.** There is no destructive one-shot command.
- **Never touch `protected`, `keep` or `recent` items.** `--include-review` widens the set to `needs-review` only, and protection is re-checked against the current config at apply time.
- **Never call an LLM, never touch the network.** The binary's only runtime dependency is a YAML parser.
- **Never modify file contents.** Files are moved or removed whole.
- **Never commit, push, or force anything.** `git mv`/`git rm` stage changes; you commit.
- **Never apply a stale plan** (older than 24 h) unless you insist with `--fresh` — and `verify-plan` gives you a CI-grade staleness gate before that.
- **Never operate outside git.** Untracked files are skipped by `apply`; everything is revertible with plain git.

Honest limitations: reference matching is substring-based and can over-match (that errs safe: more references means more conservative verdicts); the task-merged heuristic is exactly that, and plan docs always land in the plan file for human eyes; built-in globs are deliberately conservative — extend them via config rather than waiting for us.

## Roadmap

- **Git hook for new debris** — a `post-commit` hook that flags freshly detected artifacts before they accumulate.
- **cronagent integration** — scheduled janitor runs via our sibling project cronagent: generate a plan nightly, let verify-plan + apply run as a reviewed batch job.
- **Session-transcript parsing for attribution** — tie each artifact back to the agent session that produced it, and surface "orphaned by session X" evidence.

## Kill risks

- **Vendors shipping built-in housekeeping.** If agent platforms add a first-party `/housekeeping` command, the niche narrows; agent-janitor's bet is that vendor cleanup will be agent-driven (the thing teams do not trust), while this tool stays deterministic, portable and CI-first.
- **OpenSpec-style suites extending archive scope.** Tooling that manages its own plan lifecycle could absorb the archive step; the counter is that agent-janitor is repo-wide and convention-based, not tied to one workflow suite.
- **Git hosts adding hygiene dashboards.** GitHub/GitLab could surface "stale plan docs" as an insight; that informs humans but still does not execute a reviewable, deterministic cleanup.

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # builds first, then runs all dist/test/*.test.js via node --test
npm run demo    # end-to-end demo in a temp fixture repo
```

Tests are fixture-driven: each suite builds an isolated git repository in `os.tmpdir()` (with `GIT_CONFIG_NOSYSTEM=1`, an empty `GIT_CONFIG_GLOBAL`, repo-local identity and pinned commit dates). No network access anywhere. Windows is a first-class platform (the suite runs on ubuntu and windows in CI, Node 20/22/24).

## License

[MIT](LICENSE) — (c) 2026 agent-janitor contributors
